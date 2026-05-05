'use strict';

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const STORAGE_DIR = process.env.STORAGE_DIR || ROOT;
const DATA_DIR = path.join(STORAGE_DIR, 'data');
const BACKUP_DIR = path.join(STORAGE_DIR, 'backups');
const STATE_FILE = path.join(DATA_DIR, 'estoque.json');

const DEFAULT_USERS = [
  { username: 'admin', password: 'admin', role: 'admin' },
  { username: 'usuario', password: 'usuario', role: 'user' },
];

const DEFAULT_STATE = {
  versao: 3,
  produtos: [],
  entradas: [],
  saidas: [],
  ajustes: [],
  config: { estoqueMin: 5, estoqueMax: 100 },
  users: DEFAULT_USERS,
  atualizado_em: null,
};

const CONTAGEM_INICIAL_PADRAO = 300;
const CONTAGEM_INICIAL_MOTIVO_PREFIX = 'Contagem inicial';

const DESTINOS_VALIDOS = new Set(['cliente', 'cancelamento', 'devolucao', 'defeitos']);
const TAMANHOS_ORDEM = ['P', 'M', 'G', 'GG', 'G1', 'G2', 'G3'];
const TAMANHOS_VALIDOS = new Set(TAMANHOS_ORDEM);
const TAMANHOS_RANK = Object.fromEntries(TAMANHOS_ORDEM.map((t, i) => [t, i]));

function ordenarTamanhos(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.slice().sort((a, b) => {
    const ra = TAMANHOS_RANK[a] != null ? TAMANHOS_RANK[a] : 999;
    const rb = TAMANHOS_RANK[b] != null ? TAMANHOS_RANK[b] : 999;
    return ra - rb;
  });
}

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function loadState() {
  ensureDirs();
  if (!fs.existsSync(STATE_FILE)) {
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const data = JSON.parse(raw);
    const produtos = Array.isArray(data.produtos) ? data.produtos : [];
    // Migração: produtos com tamanhos vazios ou ausentes recebem todos os tamanhos padrão.
    // Cobre auto-cadastros antigos do ERP que herdavam só os tamanhos vistos no relatório.
    const TODOS_TAMS = TAMANHOS_ORDEM.slice();
    let migradosVazio = 0, reordenados = 0;
    produtos.forEach(p => {
      if (!Array.isArray(p.tamanhos) || p.tamanhos.length === 0) {
        p.tamanhos = TODOS_TAMS.slice();
        migradosVazio++;
      } else {
        const ordenado = ordenarTamanhos(p.tamanhos);
        const era = p.tamanhos.join(',');
        if (ordenado.join(',') !== era) {
          p.tamanhos = ordenado;
          reordenados++;
        }
      }
    });
    if (migradosVazio > 0) console.log('[state] preencheu tamanhos em', migradosVazio, 'produto(s) vazio(s)');
    if (reordenados > 0) console.log('[state] reordenou tamanhos em', reordenados, 'produto(s)');
    let dirty = migradosVazio > 0 || reordenados > 0;
    const ajustes = Array.isArray(data.ajustes) ? data.ajustes : [];
    // Migração: para QUALQUER (codigo, tamanho) sem ajuste registrado, cria 300 un. de
    // contagem inicial. Cobre tanto produtos auto-cadastrados quanto produtos manuais
    // ou seed que ficaram sem ajuste por algum motivo (seed parcial, deploy migrado, etc.).
    // Idempotente: SKUs com qualquer ajuste preexistente são pulados.
    const ajustesIndex = new Set();
    ajustes.forEach(a => ajustesIndex.add(a.codigo + '|' + a.tamanho));
    let contagensCriadas = 0;
    const hojeIso = new Date().toISOString().slice(0, 10);
    produtos.forEach(p => {
      (p.tamanhos || []).forEach(t => {
        if (ajustesIndex.has(p.codigo + '|' + t)) return;
        ajustes.push({
          id: uid(),
          codigo: p.codigo,
          tamanho: t,
          data: hojeIso,
          qtdContada: CONTAGEM_INICIAL_PADRAO,
          qtdAnterior: 0,
          diferenca: CONTAGEM_INICIAL_PADRAO,
          motivo: CONTAGEM_INICIAL_MOTIVO_PREFIX + ' (preenchimento)',
          origem: 'auto-fix-migration',
        });
        ajustesIndex.add(p.codigo + '|' + t);
        contagensCriadas++;
      });
    });
    if (contagensCriadas > 0) console.log('[state] criou', contagensCriadas, 'contagem(ns) inicial(is) em SKUs sem ajuste');
    if (contagensCriadas > 0) dirty = true;
    return {
      versao: data.versao || 3,
      produtos,
      entradas: Array.isArray(data.entradas) ? data.entradas : [],
      saidas: Array.isArray(data.saidas) ? data.saidas : [],
      ajustes,
      config: Object.assign({ estoqueMin: 5, estoqueMax: 100 }, data.config || {}),
      users: Array.isArray(data.users) && data.users.length ? data.users : DEFAULT_USERS.slice(),
      atualizado_em: data.atualizado_em || null,
      _dirty: dirty,
    };
  } catch (err) {
    console.error('[state] erro ao ler estoque.json, usando default:', err.message);
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
}

let state = loadState();
let writeQueue = Promise.resolve();

// Se a migração modificou o estado em memória, persiste já no boot pra evitar
// que um restart sem mutações refaça a migração com IDs novos.
if (state._dirty) {
  delete state._dirty;
  // Dispara persist em modo fire-and-forget; o writeQueue garante serialização.
  Promise.resolve().then(() => persist()).catch(err => console.error('[boot persist]', err));
} else {
  delete state._dirty;
}

function persist() {
  writeQueue = writeQueue.then(async () => {
    state.atualizado_em = new Date().toISOString();
    const json = JSON.stringify(state, null, 2);
    const tmp = STATE_FILE + '.tmp';
    await fsp.writeFile(tmp, json, 'utf8');
    await fsp.rename(tmp, STATE_FILE);
    await writeBackup(json);
  }).catch(err => {
    console.error('[persist] erro:', err);
  });
  return writeQueue;
}

async function writeBackup(json) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const dailyFile = path.join(BACKUP_DIR, 'backup_estoque_' + today + '.json');
    await fsp.writeFile(dailyFile, json, 'utf8');
    await rotateBackups();
  } catch (err) {
    console.error('[backup] erro:', err.message);
  }
}

async function rotateBackups() {
  const KEEP = 30;
  const files = (await fsp.readdir(BACKUP_DIR))
    .filter(f => f.startsWith('backup_estoque_') && f.endsWith('.json'))
    .sort();
  if (files.length <= KEEP) return;
  const remove = files.slice(0, files.length - KEEP);
  for (const f of remove) {
    try { await fsp.unlink(path.join(BACKUP_DIR, f)); } catch (_) {}
  }
}

function publicState() {
  return {
    versao: state.versao,
    produtos: state.produtos,
    entradas: state.entradas,
    saidas: state.saidas,
    ajustes: state.ajustes,
    config: state.config,
    atualizado_em: state.atualizado_em,
  };
}

function publicUser(u) {
  return { username: u.username, email: u.email || '', role: u.role };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidEmail(s) { return EMAIL_RE.test(s); }

function findUserByLogin(login) {
  const q = (login || '').toLowerCase();
  return state.users.find(u =>
    u.username.toLowerCase() === q ||
    (u.email && u.email.toLowerCase() === q)
  ) || null;
}

function findUserByToken(token) {
  if (!token) return null;
  let decoded;
  try {
    decoded = Buffer.from(token, 'base64').toString('utf8');
  } catch (_) { return null; }
  const sep = decoded.indexOf(':');
  if (sep === -1) return null;
  const username = decoded.slice(0, sep);
  const password = decoded.slice(sep + 1);
  return state.users.find(u =>
    u.username.toLowerCase() === username.toLowerCase() && u.password === password
  ) || null;
}

function calcEstoqueSku(codigo, tamanho) {
  let ent = 0, sai = 0, aj = 0;
  for (const e of state.entradas) if (e.codigo === codigo && e.tamanho === tamanho) ent += e.quantidade;
  for (const s of state.saidas) if (s.codigo === codigo && s.tamanho === tamanho) sai += s.quantidade;
  for (const a of state.ajustes) if (a.codigo === codigo && a.tamanho === tamanho) aj += a.diferenca;
  return ent - sai + aj;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function asInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : NaN;
}
function asNum(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : NaN;
}
function asStr(v) {
  return (v == null ? '' : String(v)).trim();
}
function asTamanho(v) {
  const t = asStr(v).toUpperCase();
  return TAMANHOS_VALIDOS.has(t) ? t : '';
}
function normalizeTamanhos(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const t of arr) {
    const n = asTamanho(t);
    if (n && !out.includes(n)) out.push(n);
  }
  return ordenarTamanhos(out);
}

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(ROOT, { extensions: ['html'] }));

function authMiddleware(req, res, next) {
  const token = req.headers['x-auth'] || '';
  const user = findUserByToken(token);
  if (!user) return res.status(401).json({ error: 'Não autenticado.' });
  req.user = user;
  next();
}

function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Acesso restrito ao administrador.' });
  }
  next();
}

app.post('/api/login', (req, res) => {
  const login = asStr((req.body && (req.body.login || req.body.username)) || '');
  const password = asStr(req.body && req.body.password);
  const candidate = findUserByLogin(login);
  if (!candidate || candidate.password !== password) {
    return res.status(401).json({ error: 'Usuário/e-mail ou senha inválidos.' });
  }
  const token = Buffer.from(candidate.username + ':' + candidate.password, 'utf8').toString('base64');
  res.json({ token, user: publicUser(candidate) });
});

app.get('/api/state', authMiddleware, (req, res) => {
  res.json(publicState());
});

app.get('/api/backup', authMiddleware, (req, res) => {
  const filename = 'backup_estoque_' + new Date().toISOString().slice(0, 10) + '.json';
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
  res.send(JSON.stringify(publicState(), null, 2));
});

app.post('/api/restore', authMiddleware, adminOnly, async (req, res) => {
  const data = req.body || {};
  if (!Array.isArray(data.produtos)) {
    return res.status(400).json({ error: 'Backup inválido: produtos ausente.' });
  }
  state.produtos = data.produtos;
  state.entradas = Array.isArray(data.entradas) ? data.entradas : [];
  state.saidas = Array.isArray(data.saidas) ? data.saidas : [];
  state.ajustes = Array.isArray(data.ajustes) ? data.ajustes : [];
  if (data.config && typeof data.config === 'object') {
    state.config = Object.assign({ estoqueMin: 5, estoqueMax: 100 }, data.config);
  }
  await persist();
  broadcast();
  res.json({ ok: true });
});

app.put('/api/config', authMiddleware, adminOnly, async (req, res) => {
  const min = asInt(req.body && req.body.estoqueMin);
  const max = asInt(req.body && req.body.estoqueMax);
  if (!Number.isFinite(min) || min < 0) return res.status(400).json({ error: 'Estoque mínimo inválido.' });
  if (!Number.isFinite(max) || max < 0) return res.status(400).json({ error: 'Estoque máximo inválido.' });
  if (max > 0 && min > max) return res.status(400).json({ error: 'Mínimo não pode ser maior que o máximo.' });
  state.config = { estoqueMin: min, estoqueMax: max };
  await persist();
  broadcast();
  res.json({ ok: true, config: state.config });
});

app.post('/api/produto', authMiddleware, adminOnly, async (req, res) => {
  const b = req.body || {};
  const codigo = asInt(b.codigo);
  const item = asStr(b.item);
  const tipo = asStr(b.tipo).toUpperCase();
  const cor = asStr(b.cor).toUpperCase();
  const tamanhos = normalizeTamanhos(b.tamanhos);
  const preco = asNum(b.preco);
  if (!codigo || !item || !Number.isFinite(preco)) {
    return res.status(400).json({ error: 'Preencha código, nome e preço.' });
  }
  if (tamanhos.length === 0) {
    return res.status(400).json({ error: 'Informe ao menos um tamanho disponível.' });
  }
  if (state.produtos.some(p => p.codigo === codigo)) {
    return res.status(409).json({ error: 'Já existe um produto com o código ' + codigo + '.' });
  }
  state.produtos.push({ codigo, item, tipo, cor, tamanhos, preco, custom: true });
  state.produtos.sort((a, b) => a.codigo - b.codigo);
  await persist();
  broadcast();
  res.json({ ok: true });
});

app.put('/api/produto/:codigo', authMiddleware, adminOnly, async (req, res) => {
  const codigo = asInt(req.params.codigo);
  const idx = state.produtos.findIndex(p => p.codigo === codigo);
  if (idx === -1) return res.status(404).json({ error: 'Produto não encontrado.' });
  const b = req.body || {};
  const item = asStr(b.item);
  const preco = asNum(b.preco);
  const tamanhos = normalizeTamanhos(b.tamanhos);
  if (!item || !Number.isFinite(preco)) {
    return res.status(400).json({ error: 'Nome e preço são obrigatórios.' });
  }
  if (tamanhos.length === 0) {
    return res.status(400).json({ error: 'Informe ao menos um tamanho disponível.' });
  }
  state.produtos[idx] = Object.assign({}, state.produtos[idx], {
    item,
    tipo: asStr(b.tipo).toUpperCase(),
    cor: asStr(b.cor).toUpperCase(),
    tamanhos,
    preco,
  });
  await persist();
  broadcast();
  res.json({ ok: true });
});

app.delete('/api/produto/:codigo', authMiddleware, adminOnly, async (req, res) => {
  const codigo = asInt(req.params.codigo);
  const before = state.produtos.length;
  state.produtos = state.produtos.filter(p => p.codigo !== codigo);
  if (state.produtos.length === before) return res.status(404).json({ error: 'Produto não encontrado.' });
  await persist();
  broadcast();
  res.json({ ok: true });
});

app.post('/api/entrada', authMiddleware, async (req, res) => {
  const b = req.body || {};
  const codigo = asInt(b.codigo);
  const tamanho = asTamanho(b.tamanho);
  const data = asStr(b.data);
  const quantidade = asInt(b.quantidade);
  const custo = asNum(b.custo);
  if (!codigo || !tamanho || !data || !quantidade || !Number.isFinite(custo)) {
    return res.status(400).json({ error: 'Preencha todos os campos (incluindo o tamanho).' });
  }
  const produto = state.produtos.find(p => p.codigo === codigo);
  if (!produto) return res.status(400).json({ error: 'Produto inexistente.' });
  if (!Array.isArray(produto.tamanhos) || !produto.tamanhos.includes(tamanho)) {
    return res.status(400).json({ error: 'Tamanho ' + tamanho + ' não disponível para este produto.' });
  }
  state.entradas.push({ id: uid(), codigo, tamanho, data, quantidade, custo });
  await persist();
  broadcast();
  res.json({ ok: true });
});

app.delete('/api/entrada/:id', authMiddleware, adminOnly, async (req, res) => {
  const id = req.params.id;
  const before = state.entradas.length;
  state.entradas = state.entradas.filter(e => e.id !== id);
  if (state.entradas.length === before) return res.status(404).json({ error: 'Entrada não encontrada.' });
  await persist();
  broadcast();
  res.json({ ok: true });
});

app.post('/api/saida', authMiddleware, async (req, res) => {
  const b = req.body || {};
  const codigo = asInt(b.codigo);
  const tamanho = asTamanho(b.tamanho);
  const data = asStr(b.data);
  const quantidade = asInt(b.quantidade);
  const valor = asNum(b.valor);
  const destino = asStr(b.destino) || 'cliente';
  if (!codigo || !tamanho || !data || !quantidade || !Number.isFinite(valor)) {
    return res.status(400).json({ error: 'Preencha todos os campos (incluindo o tamanho).' });
  }
  if (!DESTINOS_VALIDOS.has(destino)) {
    return res.status(400).json({ error: 'Destino inválido.' });
  }
  const produto = state.produtos.find(p => p.codigo === codigo);
  if (!produto) return res.status(400).json({ error: 'Produto inexistente.' });
  if (!Array.isArray(produto.tamanhos) || !produto.tamanhos.includes(tamanho)) {
    return res.status(400).json({ error: 'Tamanho ' + tamanho + ' não disponível para este produto.' });
  }
  const disponivel = calcEstoqueSku(codigo, tamanho);
  if (quantidade > disponivel) {
    return res.status(409).json({ error: 'Estoque insuficiente (disponível: ' + disponivel + ').' });
  }
  state.saidas.push({ id: uid(), codigo, tamanho, data, quantidade, valor, destino });
  await persist();
  broadcast();
  res.json({ ok: true });
});

app.delete('/api/saida/:id', authMiddleware, adminOnly, async (req, res) => {
  const id = req.params.id;
  const before = state.saidas.length;
  state.saidas = state.saidas.filter(s => s.id !== id);
  if (state.saidas.length === before) return res.status(404).json({ error: 'Saída não encontrada.' });
  await persist();
  broadcast();
  res.json({ ok: true });
});

app.post('/api/ajuste', authMiddleware, async (req, res) => {
  const b = req.body || {};
  const codigo = asInt(b.codigo);
  const tamanho = asTamanho(b.tamanho);
  const data = asStr(b.data);
  const contado = asInt(b.contado);
  const motivo = asStr(b.motivo);
  if (!codigo || !tamanho || !data || !Number.isFinite(contado) || contado < 0) {
    return res.status(400).json({ error: 'Preencha todos os campos com valores válidos (incluindo o tamanho).' });
  }
  const produto = state.produtos.find(p => p.codigo === codigo);
  if (!produto) return res.status(400).json({ error: 'Produto inexistente.' });
  if (!Array.isArray(produto.tamanhos) || !produto.tamanhos.includes(tamanho)) {
    return res.status(400).json({ error: 'Tamanho ' + tamanho + ' não disponível para este produto.' });
  }
  const qtdAnterior = calcEstoqueSku(codigo, tamanho);
  const diferenca = contado - qtdAnterior;
  if (diferenca === 0) {
    return res.status(400).json({ error: 'A quantidade contada é igual ao estoque atual.' });
  }
  state.ajustes.push({ id: uid(), codigo, tamanho, data, qtdContada: contado, qtdAnterior, diferenca, motivo });
  await persist();
  broadcast();
  res.json({ ok: true });
});

app.delete('/api/ajuste/:id', authMiddleware, adminOnly, async (req, res) => {
  const id = req.params.id;
  const before = state.ajustes.length;
  state.ajustes = state.ajustes.filter(a => a.id !== id);
  if (state.ajustes.length === before) return res.status(404).json({ error: 'Ajuste não encontrado.' });
  await persist();
  broadcast();
  res.json({ ok: true });
});

app.post('/api/integracao/importar', authMiddleware, adminOnly, async (req, res) => {
  const b = req.body || {};
  const rows = Array.isArray(b.rows) ? b.rows : null;
  const dryRun = !!b.dryRun;
  const acao = asStr(b.acao) === 'contagem' ? 'contagem' : 'saidas';
  const dataContagem = asStr(b.dataContagem);
  const dataEmissao = asStr(b.dataEmissao);
  const motivoBase = asStr(b.motivo) || (acao === 'contagem' ? 'Contagem ERP ' + (dataContagem || '') : 'Saídas ERP ' + (dataContagem || ''));
  if (!rows) return res.status(400).json({ error: 'Lista de linhas ausente.' });
  if (rows.length === 0) return res.status(400).json({ error: 'Nenhuma linha para importar.' });
  if (rows.length > 5000) return res.status(400).json({ error: 'Limite de 5000 linhas por importação.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dataContagem)) {
    return res.status(400).json({ error: 'Data inválida (use YYYY-MM-DD).' });
  }

  const result = {
    saidasCriadas: 0,
    ajustesCriados: 0,
    produtosCriados: 0,
    tamanhosAdicionados: 0,
    invalidas: 0,
    semDiferenca: 0,
    problemas: [],
  };
  const novasSaidas = [];
  const novosAjustes = [];
  const novosProdutos = [];
  const tamanhosPendentes = new Map();

  function buscarOuCriarProduto(linha, codigo, tipo, cor, descricao, preco) {
    let p = state.produtos.find(x => x.codigo === codigo);
    if (p) return p;
    p = novosProdutos.find(x => x.codigo === codigo);
    if (p) return p;
    if (!tipo || !cor) {
      result.problemas.push({ linha, motivo: 'Não foi possível inferir tipo/cor para o código ' + codigo + ' a partir da descrição "' + descricao + '"' });
      return null;
    }
    const item = tipo + '-' + cor;
    // Auto-cadastro pré-popula TODOS os tamanhos padrão; tamanhos não mencionados
    // no relatório ainda estarão disponíveis pra movimentação manual depois.
    p = {
      codigo,
      item,
      tipo,
      cor,
      tamanhos: Array.from(TAMANHOS_VALIDOS),
      preco: Number.isFinite(preco) && preco > 0 ? preco : 0,
      custom: true,
      autoCadastro: true,
      descricaoErp: descricao || '',
    };
    novosProdutos.push(p);
    result.produtosCriados++;
    return p;
  }

  function adicionarTamanhoSeNecessario(produto, tamanho) {
    if (!produto.tamanhos) produto.tamanhos = [];
    if (produto.tamanhos.includes(tamanho)) return false;
    produto.tamanhos.push(tamanho);
    produto.tamanhos = ordenarTamanhos(produto.tamanhos);
    if (!novosProdutos.includes(produto)) {
      const key = produto.codigo;
      if (!tamanhosPendentes.has(key)) tamanhosPendentes.set(key, new Set());
      tamanhosPendentes.get(key).add(tamanho);
    }
    result.tamanhosAdicionados++;
    return true;
  }

  rows.forEach((row, i) => {
    const linha = i + 1;
    const codigo = asInt(row.codigo);
    const tamanho = asTamanho(row.tamanho);
    const quantidade = asInt(row.quantidade);
    const tipo = asStr(row.tipo).toUpperCase();
    const cor = asStr(row.cor).toUpperCase();
    const descricao = asStr(row.descricao);
    const preco = asNum(row.preco);

    if (!codigo) { result.invalidas++; result.problemas.push({ linha, motivo: 'Código inválido (' + row.codigo + ')' }); return; }
    if (!tamanho) { result.invalidas++; result.problemas.push({ linha, motivo: 'Tamanho inválido (' + row.tamanho + ')' }); return; }
    if (!Number.isFinite(quantidade) || quantidade < 0) { result.invalidas++; result.problemas.push({ linha, motivo: 'Quantidade inválida (' + row.quantidade + ')' }); return; }

    const produto = buscarOuCriarProduto(linha, codigo, tipo, cor, descricao, preco);
    if (!produto) { result.invalidas++; return; }
    adicionarTamanhoSeNecessario(produto, tamanho);

    if (acao === 'saidas') {
      if (quantidade === 0) { result.semDiferenca++; return; }
      novasSaidas.push({
        id: uid(),
        codigo,
        tamanho,
        data: dataContagem,
        quantidade,
        valor: 0,
        destino: 'cliente',
        origem: 'erp-import',
        dataEmissao: dataEmissao || null,
        motivo: motivoBase,
      });
      result.saidasCriadas++;
    } else {
      // acao === 'contagem': cria ajuste com qtdContada = quantidade
      const eExistente = state.produtos.includes(produto);
      const qtdAnterior = eExistente ? calcEstoqueSku(codigo, tamanho) : 0;
      const diferenca = quantidade - qtdAnterior;
      if (diferenca === 0) { result.semDiferenca++; return; }
      novosAjustes.push({
        id: uid(),
        codigo,
        tamanho,
        data: dataContagem,
        qtdContada: quantidade,
        qtdAnterior,
        diferenca,
        motivo: motivoBase,
        origem: 'erp-import',
        dataEmissao: dataEmissao || null,
      });
      result.ajustesCriados++;
    }
  });

  // Para cada produto recém-criado, gera 300 unidades de contagem inicial em cada tamanho.
  // Isso garante que SKUs auto-cadastrados começam com a mesma baseline do seed.
  const ajustesContagemInicial = [];
  if (acao === 'saidas' || acao === 'contagem') {
    novosProdutos.forEach(p => {
      (p.tamanhos || []).forEach(t => {
        ajustesContagemInicial.push({
          id: uid(),
          codigo: p.codigo,
          tamanho: t,
          data: dataContagem,
          qtdContada: CONTAGEM_INICIAL_PADRAO,
          qtdAnterior: 0,
          diferenca: CONTAGEM_INICIAL_PADRAO,
          motivo: CONTAGEM_INICIAL_MOTIVO_PREFIX + ' (auto-cadastro)',
          origem: 'erp-import',
        });
      });
    });
  }
  if (ajustesContagemInicial.length > 0) {
    result.contagensIniciais = ajustesContagemInicial.length;
  }

  if (!dryRun) {
    if (novosProdutos.length > 0) {
      state.produtos.push(...novosProdutos);
      state.produtos.sort((a, b) => a.codigo - b.codigo);
    }
    for (const [codigo, set] of tamanhosPendentes.entries()) {
      const p = state.produtos.find(x => x.codigo === codigo);
      if (!p) continue;
      if (!Array.isArray(p.tamanhos)) p.tamanhos = [];
      for (const t of set) if (!p.tamanhos.includes(t)) p.tamanhos.push(t);
      p.tamanhos = ordenarTamanhos(p.tamanhos);
    }
    // Adiciona as contagens iniciais ANTES das saídas, pra que o cálculo de estoque
    // por SKU já tenha a baseline quando as saídas forem aplicadas.
    if (ajustesContagemInicial.length > 0) state.ajustes.push(...ajustesContagemInicial);
    if (novasSaidas.length > 0) state.saidas.push(...novasSaidas);
    if (novosAjustes.length > 0) state.ajustes.push(...novosAjustes);
    if (novosProdutos.length > 0 || novasSaidas.length > 0 || novosAjustes.length > 0 || ajustesContagemInicial.length > 0 || tamanhosPendentes.size > 0) {
      await persist();
      broadcast();
    }
  }
  res.json(result);
});

app.get('/api/users', authMiddleware, adminOnly, (req, res) => {
  res.json(state.users.map(publicUser));
});

app.post('/api/users', authMiddleware, adminOnly, async (req, res) => {
  const b = req.body || {};
  const username = asStr(b.username);
  const email = asStr(b.email).toLowerCase();
  const password = asStr(b.password);
  const role = asStr(b.role) === 'admin' ? 'admin' : 'user';
  if (!username || !email || !password) return res.status(400).json({ error: 'Usuário, e-mail e senha são obrigatórios.' });
  if (username.length < 3) return res.status(400).json({ error: 'Usuário deve ter ao menos 3 caracteres.' });
  if (!isValidEmail(email)) return res.status(400).json({ error: 'E-mail inválido.' });
  if (password.length < 4) return res.status(400).json({ error: 'Senha deve ter ao menos 4 caracteres.' });
  if (state.users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
    return res.status(409).json({ error: 'Já existe um usuário com esse nome.' });
  }
  if (state.users.some(u => (u.email || '').toLowerCase() === email)) {
    return res.status(409).json({ error: 'Já existe um usuário com esse e-mail.' });
  }
  state.users.push({ username, email, password, role });
  await persist();
  res.json({ ok: true, user: publicUser({ username, email, role }) });
});

app.put('/api/users/:username', authMiddleware, adminOnly, async (req, res) => {
  const target = asStr(req.params.username).toLowerCase();
  const idx = state.users.findIndex(u => u.username.toLowerCase() === target);
  if (idx === -1) return res.status(404).json({ error: 'Usuário não encontrado.' });
  const b = req.body || {};
  const newPassword = b.password !== undefined ? asStr(b.password) : null;
  const newEmail = b.email !== undefined ? asStr(b.email).toLowerCase() : null;
  const newRole = b.role !== undefined ? (asStr(b.role) === 'admin' ? 'admin' : 'user') : null;
  if (newPassword !== null && newPassword !== '') {
    if (newPassword.length < 4) return res.status(400).json({ error: 'Senha deve ter ao menos 4 caracteres.' });
    state.users[idx].password = newPassword;
  }
  if (newEmail !== null && newEmail !== '') {
    if (!isValidEmail(newEmail)) return res.status(400).json({ error: 'E-mail inválido.' });
    if (state.users.some((u, i) => i !== idx && (u.email || '').toLowerCase() === newEmail)) {
      return res.status(409).json({ error: 'Já existe um usuário com esse e-mail.' });
    }
    state.users[idx].email = newEmail;
  }
  if (newRole !== null && newRole !== state.users[idx].role) {
    if (state.users[idx].role === 'admin' && newRole !== 'admin') {
      const admins = state.users.filter(u => u.role === 'admin').length;
      if (admins <= 1) return res.status(400).json({ error: 'Não é possível remover o último administrador.' });
    }
    state.users[idx].role = newRole;
  }
  await persist();
  res.json({ ok: true });
});

app.delete('/api/users/:username', authMiddleware, adminOnly, async (req, res) => {
  const target = asStr(req.params.username).toLowerCase();
  const idx = state.users.findIndex(u => u.username.toLowerCase() === target);
  if (idx === -1) return res.status(404).json({ error: 'Usuário não encontrado.' });
  if (state.users[idx].username.toLowerCase() === req.user.username.toLowerCase()) {
    return res.status(400).json({ error: 'Você não pode excluir a si mesmo.' });
  }
  if (state.users[idx].role === 'admin') {
    const admins = state.users.filter(u => u.role === 'admin').length;
    if (admins <= 1) return res.status(400).json({ error: 'Não é possível remover o último administrador.' });
  }
  state.users.splice(idx, 1);
  await persist();
  res.json({ ok: true });
});

app.put('/api/me/password', authMiddleware, async (req, res) => {
  const b = req.body || {};
  const currentPassword = asStr(b.currentPassword);
  const newPassword = asStr(b.newPassword);
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Informe a senha atual e a nova senha.' });
  if (newPassword.length < 4) return res.status(400).json({ error: 'Nova senha deve ter ao menos 4 caracteres.' });
  const idx = state.users.findIndex(u => u.username.toLowerCase() === req.user.username.toLowerCase());
  if (idx === -1) return res.status(404).json({ error: 'Usuário não encontrado.' });
  if (state.users[idx].password !== currentPassword) return res.status(401).json({ error: 'Senha atual incorreta.' });
  state.users[idx].password = newPassword;
  await persist();
  const newToken = Buffer.from(state.users[idx].username + ':' + newPassword, 'utf8').toString('base64');
  res.json({ ok: true, token: newToken });
});

app.post('/api/seed-produtos', authMiddleware, adminOnly, async (req, res) => {
  const lista = Array.isArray(req.body && req.body.produtos) ? req.body.produtos : null;
  if (!lista) return res.status(400).json({ error: 'Lista inválida.' });
  if (state.produtos.length > 0) return res.status(409).json({ error: 'Catálogo já populado.' });
  state.produtos = lista;
  await persist();
  broadcast();
  res.json({ ok: true });
});

app.post('/api/reset-catalogo', authMiddleware, adminOnly, async (req, res) => {
  if (state.entradas.length > 0 || state.saidas.length > 0) {
    return res.status(409).json({ error: 'Não é possível resetar: existem entradas/saídas registradas.' });
  }
  state.produtos = [];
  state.ajustes = [];
  await persist();
  broadcast();
  res.json({ ok: true });
});

app.use((err, req, res, next) => {
  console.error('[express]', err);
  res.status(500).json({ error: 'Erro interno do servidor.' });
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  const user = findUserByToken(token);
  if (!user) return next(new Error('unauthorized'));
  socket.data.user = publicUser(user);
  next();
});

io.on('connection', (socket) => {
  socket.emit('state', publicState());
  socket.emit('presence', { count: io.engine.clientsCount });
  socket.broadcast.emit('presence', { count: io.engine.clientsCount });
  socket.on('disconnect', () => {
    io.emit('presence', { count: io.engine.clientsCount });
  });
});

function broadcast() {
  io.emit('state', publicState());
}

server.listen(PORT, () => {
  console.log('================================================');
  console.log('  Controle de Estoque — Confecção (modo servidor)');
  console.log('  Servidor ouvindo em http://localhost:' + PORT);
  console.log('  Dados:    ' + STATE_FILE);
  console.log('  Backups:  ' + BACKUP_DIR);
  console.log('================================================');
});
