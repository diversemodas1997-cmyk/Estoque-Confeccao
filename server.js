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
  versao: 2,
  produtos: [],
  entradas: [],
  saidas: [],
  ajustes: [],
  config: { estoqueMin: 5, estoqueMax: 100 },
  users: DEFAULT_USERS,
  atualizado_em: null,
};

const DESTINOS_VALIDOS = new Set(['cliente', 'cancelamento', 'devolucao', 'defeitos']);

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
    return {
      versao: data.versao || 2,
      produtos: Array.isArray(data.produtos) ? data.produtos : [],
      entradas: Array.isArray(data.entradas) ? data.entradas : [],
      saidas: Array.isArray(data.saidas) ? data.saidas : [],
      ajustes: Array.isArray(data.ajustes) ? data.ajustes : [],
      config: Object.assign({ estoqueMin: 5, estoqueMax: 100 }, data.config || {}),
      users: Array.isArray(data.users) && data.users.length ? data.users : DEFAULT_USERS.slice(),
      atualizado_em: data.atualizado_em || null,
    };
  } catch (err) {
    console.error('[state] erro ao ler estoque.json, usando default:', err.message);
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
}

let state = loadState();
let writeQueue = Promise.resolve();

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

function calcEstoqueProduto(codigo) {
  let ent = 0, sai = 0, aj = 0;
  for (const e of state.entradas) if (e.codigo === codigo) ent += e.quantidade;
  for (const s of state.saidas) if (s.codigo === codigo) sai += s.quantidade;
  for (const a of state.ajustes) if (a.codigo === codigo) aj += a.diferenca;
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
  const tamanho = asStr(b.tamanho).toUpperCase();
  const preco = asNum(b.preco);
  if (!codigo || !item || !Number.isFinite(preco)) {
    return res.status(400).json({ error: 'Preencha código, nome e preço.' });
  }
  if (state.produtos.some(p => p.codigo === codigo)) {
    return res.status(409).json({ error: 'Já existe um produto com o código ' + codigo + '.' });
  }
  state.produtos.push({ codigo, item, tipo, cor, tamanho, preco, custom: true });
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
  if (!item || !Number.isFinite(preco)) {
    return res.status(400).json({ error: 'Nome e preço são obrigatórios.' });
  }
  state.produtos[idx] = Object.assign({}, state.produtos[idx], {
    item,
    tipo: asStr(b.tipo).toUpperCase(),
    cor: asStr(b.cor).toUpperCase(),
    tamanho: asStr(b.tamanho).toUpperCase(),
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
  const data = asStr(b.data);
  const quantidade = asInt(b.quantidade);
  const custo = asNum(b.custo);
  if (!codigo || !data || !quantidade || !Number.isFinite(custo)) {
    return res.status(400).json({ error: 'Preencha todos os campos.' });
  }
  if (!state.produtos.some(p => p.codigo === codigo)) {
    return res.status(400).json({ error: 'Produto inexistente.' });
  }
  state.entradas.push({ id: uid(), codigo, data, quantidade, custo });
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

app.post('/api/integracao/importar', authMiddleware, adminOnly, async (req, res) => {
  const b = req.body || {};
  const rows = Array.isArray(b.rows) ? b.rows : null;
  const dryRun = !!b.dryRun;
  if (!rows) return res.status(400).json({ error: 'Lista de linhas ausente.' });
  if (rows.length === 0) return res.status(400).json({ error: 'Nenhuma linha para importar.' });
  if (rows.length > 5000) return res.status(400).json({ error: 'Limite de 5000 linhas por importação.' });

  function normSku(s) { return String(s || '').toUpperCase().replace(/\s+/g, '').trim(); }
  const skuIndex = new Map();
  for (const p of state.produtos) {
    const skuKey = normSku(p.sku || p.item);
    if (skuKey) skuIndex.set(skuKey, p);
  }
  const externalIdsExistentes = new Set();
  for (const s of state.saidas) if (s.externalId) externalIdsExistentes.add(String(s.externalId));

  const result = { criadas: 0, duplicadas: 0, naoMapeadas: 0, invalidas: 0, problemas: [] };
  const novasSaidas = [];
  const externalIdsLote = new Set();

  rows.forEach((row, i) => {
    const linha = i + 1;
    const sku = normSku(row.sku);
    const quantidade = parseInt(row.quantidade, 10);
    const valor = parseFloat(row.valor);
    const data = asStr(row.data);
    const externalId = asStr(row.externalId);
    const destino = DESTINOS_VALIDOS.has(asStr(row.destino)) ? asStr(row.destino) : 'cliente';

    if (!sku) { result.invalidas++; result.problemas.push({ linha, motivo: 'SKU vazio' }); return; }
    if (!Number.isFinite(quantidade) || quantidade <= 0) { result.invalidas++; result.problemas.push({ linha, motivo: 'Quantidade inválida (' + row.quantidade + ')' }); return; }
    if (!Number.isFinite(valor) || valor < 0) { result.invalidas++; result.problemas.push({ linha, motivo: 'Valor inválido (' + row.valor + ')' }); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) { result.invalidas++; result.problemas.push({ linha, motivo: 'Data inválida (' + row.data + ', use YYYY-MM-DD)' }); return; }

    const produto = skuIndex.get(sku);
    if (!produto) { result.naoMapeadas++; result.problemas.push({ linha, motivo: 'SKU "' + sku + '" não encontrado nos produtos' }); return; }

    if (externalId) {
      if (externalIdsExistentes.has(externalId) || externalIdsLote.has(externalId)) {
        result.duplicadas++;
        result.problemas.push({ linha, motivo: 'Pedido ' + externalId + ' já importado anteriormente' });
        return;
      }
      externalIdsLote.add(externalId);
    }

    novasSaidas.push({
      id: uid(),
      codigo: produto.codigo,
      data,
      quantidade,
      valor,
      destino,
      origem: 'erp-import',
      externalId: externalId || null,
    });
    result.criadas++;
  });

  if (!dryRun && novasSaidas.length > 0) {
    state.saidas.push(...novasSaidas);
    await persist();
    broadcast();
  }
  res.json(result);
});

app.post('/api/saida', authMiddleware, async (req, res) => {
  const b = req.body || {};
  const codigo = asInt(b.codigo);
  const data = asStr(b.data);
  const quantidade = asInt(b.quantidade);
  const valor = asNum(b.valor);
  const destino = asStr(b.destino) || 'cliente';
  if (!codigo || !data || !quantidade || !Number.isFinite(valor)) {
    return res.status(400).json({ error: 'Preencha todos os campos.' });
  }
  if (!DESTINOS_VALIDOS.has(destino)) {
    return res.status(400).json({ error: 'Destino inválido.' });
  }
  const disponivel = calcEstoqueProduto(codigo);
  if (quantidade > disponivel) {
    return res.status(409).json({ error: 'Estoque insuficiente (disponível: ' + disponivel + ').' });
  }
  state.saidas.push({ id: uid(), codigo, data, quantidade, valor, destino });
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
  const data = asStr(b.data);
  const contado = asInt(b.contado);
  const motivo = asStr(b.motivo);
  if (!codigo || !data || !Number.isFinite(contado) || contado < 0) {
    return res.status(400).json({ error: 'Preencha todos os campos com valores válidos.' });
  }
  const qtdAnterior = calcEstoqueProduto(codigo);
  const diferenca = contado - qtdAnterior;
  if (diferenca === 0) {
    return res.status(400).json({ error: 'A quantidade contada é igual ao estoque atual.' });
  }
  state.ajustes.push({ id: uid(), codigo, data, qtdContada: contado, qtdAnterior, diferenca, motivo });
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
