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
const USERS_FILE = path.join(DATA_DIR, 'users.json');

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

// Catálogo canônico ERP — fonte de verdade pra criação de produtos faltantes e dedup.
// Mantém em sincronia com ERP_CATALOGO no client.
const ERP_CATALOGO = [
  { codigo: 12, tipo: 'PM.LISA',     cor: 'PRE'     },
  { codigo: 13, tipo: 'PM.LISA',     cor: 'BEGE'    },
  { codigo: 14, tipo: 'PM.LISA',     cor: 'ROXO'    },
  { codigo: 15, tipo: 'PM.LISA',     cor: 'BRA'     },
  { codigo: 16, tipo: 'PM.LISA',     cor: 'AZUL'    },
  { codigo: 17, tipo: 'CM.LISA',     cor: 'PRE'     },
  { codigo: 18, tipo: 'CM.LISA',     cor: 'BEGE'    },
  { codigo: 19, tipo: 'CM.LISA',     cor: 'ROXO'    },
  { codigo: 20, tipo: 'CM.LISA',     cor: 'BRA'     },
  { codigo: 21, tipo: 'CM.LISA',     cor: 'VERM'    },
  { codigo: 22, tipo: 'CM.LISA',     cor: 'VERDE'   },
  { codigo: 23, tipo: 'CM.LISA',     cor: 'GRAF'    },
  { codigo: 24, tipo: 'CM.LISA',     cor: 'MARINHO' },
  { codigo: 25, tipo: 'CM.LISA',     cor: 'MARROM'  },
  { codigo: 26, tipo: 'CM.TRI.LISA', cor: 'CAQUI'   },
  { codigo: 27, tipo: 'SM.LISA',     cor: 'PRE'     },
  { codigo: 28, tipo: 'SM.LISA',     cor: 'BEGE'    },
  { codigo: 29, tipo: 'SM.LISA',     cor: 'CINZA'   },
  { codigo: 30, tipo: 'SM.LISA',     cor: 'BRA'     },
  { codigo: 31, tipo: 'SM.LISA',     cor: 'MARINHO' },
  { codigo: 32, tipo: 'SM.LISA',     cor: 'MARROM'  },
  { codigo: 33, tipo: 'BM.LISA',     cor: 'PRE'     },
  { codigo: 34, tipo: 'BM.LISA',     cor: 'BEGE'    },
  { codigo: 35, tipo: 'BM.LISA',     cor: 'ROXO'    },
  { codigo: 36, tipo: 'BM.LISA',     cor: 'BRA'     },
  { codigo: 37, tipo: 'BM.LISA',     cor: 'VERM'    },
  { codigo: 38, tipo: 'BM.LISA',     cor: 'VERDE'   },
  { codigo: 39, tipo: 'BM.LISA',     cor: 'MARROM'  },
  { codigo: 40, tipo: 'BM.LISA',     cor: 'MOSTARDA'},
  { codigo: 41, tipo: 'CM.TRI.LISA', cor: 'VERDE'   },
  { codigo: 42, tipo: 'CM.REC.LISA', cor: 'VERDE'   },
  { codigo: 43, tipo: 'CM.REC.LISA', cor: 'VERM'    },
  { codigo: 44, tipo: 'CM.REC.LISA', cor: 'PRE'     },
  { codigo: 51, tipo: 'CM.TRI.LISA', cor: 'PRE'     },
  { codigo: 52, tipo: 'CM.TRI.LISA', cor: 'BRA'     },
  { codigo: 53, tipo: 'CM.REC.LISA', cor: 'ROXO'    },
  { codigo: 54, tipo: 'CONJINF',     cor: 'GRAF'    },
  { codigo: 55, tipo: 'CONJINF',     cor: 'MARSALA' },
  { codigo: 56, tipo: 'CONJINF',     cor: 'MESCLA'  },
  { codigo: 57, tipo: 'BERM',        cor: 'PRE'     },
  { codigo: 58, tipo: 'BERM',        cor: 'BRA'     },
  { codigo: 59, tipo: 'BERM',        cor: 'MESCLA'  },
  { codigo: 60, tipo: 'SF.BERM.FEM', cor: 'PRE'     },
  { codigo: 61, tipo: 'SF.BERM.FEM', cor: 'MARINHO' },
  { codigo: 62, tipo: 'BERM',        cor: 'MAR'     },
  { codigo: 63, tipo: 'BERM',        cor: 'GRA'     },
  { codigo: 64, tipo: 'BM.TRI',      cor: 'VERDE'   },
  { codigo: 65, tipo: 'BM.TRI',      cor: 'BEGE'    },
  { codigo: 66, tipo: 'BM.TRI',      cor: 'AZUL'    },
  { codigo: 67, tipo: 'PM.TRI.LISA', cor: 'PRE'     },
  { codigo: 68, tipo: 'CM.BLACK',    cor: 'PRE'     },
];

// Mapa item → código ERP, usado pra escolher o produto canônico em casos de duplicata.
const ERP_CODIGO_PREFERIDO = Object.fromEntries(
  ERP_CATALOGO.map(e => [e.tipo + '-' + e.cor, e.codigo])
);

// Apelidos de tipo do ERP → tipo canônico do programa (espelha TIPO_ALIASES no client).
const TIPO_ALIASES = {
  'SM.LISO': 'SM.LISA',
  'SM.LIS0': 'SM.LISA',
  'BM.LISO': 'BM.LISA',
  'CM.TRI':  'CM.TRI.LISA',
};

function tipoCanonico(tipo) {
  const t = String(tipo || '').toUpperCase().trim();
  return TIPO_ALIASES[t] || t;
}

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

function loadUsers() {
  // 1) Tenta arquivo isolado de usuários (não é tocado por migrações de produtos/ajustes).
  if (fs.existsSync(USERS_FILE)) {
    try {
      const arr = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      if (Array.isArray(arr) && arr.length > 0) return arr;
    } catch (err) {
      console.error('[users] erro ao ler users.json:', err.message);
    }
  }
  // 2) Tenta extrair de estoque.json (compatibilidade com instalações antigas).
  if (fs.existsSync(STATE_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (Array.isArray(data.users) && data.users.length > 0) return data.users;
    } catch (err) { /* ignora */ }
  }
  return DEFAULT_USERS.slice();
}

function ensureDefaultUsers(users) {
  // Garante que admin e usuario sempre existem (proteção contra perda total de acesso).
  let added = 0;
  DEFAULT_USERS.forEach(d => {
    if (!users.some(u => u.username.toLowerCase() === d.username.toLowerCase())) {
      users.push({ ...d });
      added++;
    }
  });
  return added;
}

function persistUsers(users) {
  // Escrita atômica em arquivo isolado.
  ensureDirs();
  const json = JSON.stringify(users, null, 2);
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, json, 'utf8');
  fs.renameSync(tmp, USERS_FILE);
}

function loadState() {
  ensureDirs();
  if (!fs.existsSync(STATE_FILE)) {
    const defaultState = JSON.parse(JSON.stringify(DEFAULT_STATE));
    // Mesmo em primeiro boot, carrega usuários do arquivo isolado se existir
    defaultState.users = loadUsers();
    return defaultState;
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
    // Migração: remove sufixo de tamanho colado no `item` de produtos legados (pré-refator).
    // Antes o item incluía o tamanho ('CM.LISA-PRE-G'); no novo modelo, item é a base
    // ('CM.LISA-PRE') e o tamanho é coluna separada. Sufixos sobrando causam conflito visual.
    // Cores reais (PRE, BRA, MARINHO, MARROM, MOSTARDA, MAR, MARSALA, MESCLA etc.) não
    // colidem com o regex porque não terminam em P|M|G|GG|G1|G2|G3.
    const TAM_SUFFIX_RE = /-(?:P|M|G|GG|G1|G2|G3)$/i;
    let itensCorrigidos = 0, legadosLimpos = 0;
    produtos.forEach(p => {
      if (typeof p.item === 'string' && TAM_SUFFIX_RE.test(p.item)) {
        p.item = p.item.replace(TAM_SUFFIX_RE, '');
        itensCorrigidos++;
      }
      // Remove campo `tamanho` (singular) legado — substituído por `tamanhos` (array)
      if ('tamanho' in p) {
        delete p.tamanho;
        legadosLimpos++;
      }
    });
    if (itensCorrigidos > 0) console.log('[state] limpou sufixo de tamanho em', itensCorrigidos, 'produto(s) com nome legado');
    if (legadosLimpos > 0) console.log('[state] removeu campo legado `tamanho` de', legadosLimpos, 'produto(s)');

    // Migração: canonicaliza tipo (apelidos LISO/LISA, CM.TRI/CM.TRI.LISA) e item
    let tiposCanonicalizados = 0;
    produtos.forEach(p => {
      if (typeof p.tipo === 'string') {
        const tc = tipoCanonico(p.tipo);
        if (tc !== p.tipo) {
          p.tipo = tc;
          // Reconstrói item se necessário (formato 'TIPO-COR')
          const idx = (p.item || '').indexOf('-');
          if (idx > 0) {
            const cor = p.item.slice(idx + 1);
            p.item = tc + '-' + cor;
          }
          tiposCanonicalizados++;
        }
      }
    });
    if (tiposCanonicalizados > 0) console.log('[state] canonicalizou tipo de', tiposCanonicalizados, 'produto(s) (apelidos LISO/LISA etc.)');

    // Migração: dedup produtos com mesmo `item` (mesmo tipo+cor após canonicalização).
    // Mantém o canônico (preferindo codigo ERP). Migra entradas/saídas/ajustes pra ele.
    // IMPORTANTE: ajustes precisa ser declarado AQUI (antes do dedup), porque o dedup
    // remapeia codigos em entradas/saidas/ajustes. Antes estava após o dedup, causando
    // ReferenceError por TDZ → catch retornava DEFAULT_STATE, ZERANDO toda a base.
    const entradas = Array.isArray(data.entradas) ? data.entradas : [];
    const saidas = Array.isArray(data.saidas) ? data.saidas : [];
    const ajustes = Array.isArray(data.ajustes) ? data.ajustes : [];
    const grupos = new Map();
    produtos.forEach(p => {
      const key = String(p.item || '');
      if (!key) return;
      if (!grupos.has(key)) grupos.set(key, []);
      grupos.get(key).push(p);
    });
    let duplicatasRemovidas = 0, refsRemapeadas = 0;
    const codigoMap = new Map(); // codigo antigo → codigo canônico
    const idsRemoverProdutos = new Set();
    grupos.forEach((arr, item) => {
      if (arr.length <= 1) return;
      // Escolhe canônico: 1) preferido pelo ERP_CODIGO_PREFERIDO[item]; 2) menor codigo
      const preferido = ERP_CODIGO_PREFERIDO[item];
      let canonico = arr.find(p => p.codigo === preferido) ||
                     arr.slice().sort((a, b) => a.codigo - b.codigo)[0];
      arr.forEach(p => {
        if (p === canonico) return;
        codigoMap.set(p.codigo, canonico.codigo);
        idsRemoverProdutos.add(p.codigo);
        // Une tamanhos
        (p.tamanhos || []).forEach(t => {
          if (!canonico.tamanhos) canonico.tamanhos = [];
          if (!canonico.tamanhos.includes(t)) canonico.tamanhos.push(t);
        });
        duplicatasRemovidas++;
      });
      canonico.tamanhos = ordenarTamanhos(canonico.tamanhos || []);
    });
    if (codigoMap.size > 0) {
      // Remapeia referências em entradas/saídas/ajustes
      [entradas, saidas, ajustes].forEach(arr => {
        arr.forEach(rec => {
          if (codigoMap.has(rec.codigo)) {
            rec.codigo = codigoMap.get(rec.codigo);
            refsRemapeadas++;
          }
        });
      });
      // Remove produtos duplicados
      for (let i = produtos.length - 1; i >= 0; i--) {
        if (idsRemoverProdutos.has(produtos[i].codigo)) produtos.splice(i, 1);
      }
    }
    if (duplicatasRemovidas > 0) console.log('[state] dedup:', duplicatasRemovidas, 'produto(s) duplicado(s) removido(s),', refsRemapeadas, 'referência(s) remapeada(s)');

    // Migração: garante que todos os produtos canônicos do ERP_CATALOGO existem.
    // Roda DEPOIS do dedup pra não conflitar com codigos reaproveitados. Cria produtos
    // faltantes com todos os tamanhos e custom: false (pra distinguir de cadastros manuais).
    const codigosExistentes = new Set(produtos.map(p => p.codigo));
    const TAMS_PADRAO = TAMANHOS_ORDEM.slice();
    let cadastrosCriados = 0;
    ERP_CATALOGO.forEach(e => {
      if (codigosExistentes.has(e.codigo)) return;
      // Verifica também se o item já existe sob outro código (não duplicar)
      const itemKey = e.tipo + '-' + e.cor;
      if (produtos.some(p => p.item === itemKey)) return;
      produtos.push({
        codigo: e.codigo,
        item: itemKey,
        tipo: e.tipo,
        cor: e.cor,
        tamanhos: TAMS_PADRAO.slice(),
        preco: 19.90,
        custom: false,
      });
      codigosExistentes.add(e.codigo);
      cadastrosCriados++;
    });
    if (cadastrosCriados > 0) {
      produtos.sort((a, b) => a.codigo - b.codigo);
      console.log('[state] cadastrou', cadastrosCriados, 'produto(s) canônico(s) faltante(s) do ERP_CATALOGO');
    }

    // Migração: corrige produtos existentes cujo codigo está no ERP_CATALOGO mas tipo/cor
    // divergem do canônico (resultado de auto-cadastros antigos com descrição do PDF, antes
    // do fix que faz o catálogo prevalecer). O catálogo PREVALECE — isso reescreve tipo/cor/item
    // pra valores canônicos. NÃO toca em preço/tamanhos (preserva customizações).
    let canonicalizadosErp = 0;
    produtos.forEach(p => {
      const canonico = ERP_CATALOGO.find(e => e.codigo === p.codigo);
      if (!canonico) return;
      const itemCanonico = canonico.tipo + '-' + canonico.cor;
      if (p.tipo !== canonico.tipo || p.cor !== canonico.cor || p.item !== itemCanonico) {
        console.log('[state] corrigindo produto', p.codigo,
          'de', JSON.stringify({ tipo: p.tipo, cor: p.cor, item: p.item }),
          'para', JSON.stringify({ tipo: canonico.tipo, cor: canonico.cor, item: itemCanonico }));
        p.tipo = canonico.tipo;
        p.cor = canonico.cor;
        p.item = itemCanonico;
        canonicalizadosErp++;
      }
    });
    if (canonicalizadosErp > 0) console.log('[state] canonicalizou', canonicalizadosErp, 'produto(s) pelo ERP_CATALOGO (catálogo prevalece)');

    let dirty = migradosVazio > 0 || reordenados > 0 || itensCorrigidos > 0 || legadosLimpos > 0 || tiposCanonicalizados > 0 || duplicatasRemovidas > 0 || cadastrosCriados > 0 || canonicalizadosErp > 0;
    // Migração: para QUALQUER (codigo, tamanho) sem ajuste registrado, cria 300 un. de
    // contagem inicial. Cobre tanto produtos auto-cadastrados quanto produtos manuais
    // ou seed que ficaram sem ajuste por algum motivo (seed parcial, deploy migrado, etc.).
    // Idempotente: SKUs com qualquer ajuste preexistente são pulados.
    // SÓ RODA UMA VEZ no ciclo de vida do sistema (controlado por flag seedContagemInicialFeito).
    // Isso protege contra ressemeadura após o usuário zerar a contagem pra entrar manualmente.
    let contagensCriadas = 0;
    const seedJaFeito = !!data.seedContagemInicialFeito;
    if (!seedJaFeito) {
      const ajustesIndex = new Set();
      ajustes.forEach(a => ajustesIndex.add(a.codigo + '|' + a.tamanho));
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
    } else {
      console.log('[state] seed de contagem inicial já feito antes — pulando auto-seed (modo manual ativo)');
    }
    if (contagensCriadas > 0) dirty = true;
    // Carrega usuários do arquivo isolado (primário). Garante defaults sempre presentes.
    const users = loadUsers();
    const adicionadosDefaults = ensureDefaultUsers(users);
    if (adicionadosDefaults > 0) {
      console.log('[users] restaurou', adicionadosDefaults, 'usuário(s) default que estavam ausentes');
      persistUsers(users);
    }
    // Marca que o seed inicial foi feito pra não re-seedar em boots futuros.
    // Persiste 'true' uma única vez (independente de se fizemos seed agora ou não).
    const seedContagemInicialFeito = seedJaFeito || contagensCriadas > 0 || ajustes.length > 0;
    if (seedContagemInicialFeito && !data.seedContagemInicialFeito) dirty = true;
    return {
      versao: data.versao || 3,
      produtos,
      entradas,
      saidas,
      ajustes,
      config: Object.assign({ estoqueMin: 5, estoqueMax: 100 }, data.config || {}),
      users,
      atualizado_em: data.atualizado_em || null,
      seedContagemInicialFeito,
      _dirty: dirty,
    };
  } catch (err) {
    console.error('[state] ERRO durante carregamento/migração:', err.message, err.stack);
    // Tenta recuperar pelo menos os dados brutos do arquivo, sem aplicar migrações.
    // Antes esse catch retornava DEFAULT_STATE, ZERANDO toda a base — péssimo se o erro
    // estiver na migração (não nos dados em si).
    try {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const data = JSON.parse(raw);
      console.error('[state] FALLBACK: retornando dados brutos sem migração aplicada');
      const usersFallback = loadUsers();
      ensureDefaultUsers(usersFallback);
      return {
        versao: data.versao || 3,
        produtos: Array.isArray(data.produtos) ? data.produtos : [],
        entradas: Array.isArray(data.entradas) ? data.entradas : [],
        saidas: Array.isArray(data.saidas) ? data.saidas : [],
        ajustes: Array.isArray(data.ajustes) ? data.ajustes : [],
        config: Object.assign({ estoqueMin: 5, estoqueMax: 100 }, data.config || {}),
        users: usersFallback,
        atualizado_em: data.atualizado_em || null,
      };
    } catch (err2) {
      console.error('[state] fallback tambem falhou, usando DEFAULT_STATE:', err2.message);
      return JSON.parse(JSON.stringify(DEFAULT_STATE));
    }
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
    // Escreve users.json em separado (isolado de migrações de produtos/ajustes)
    try {
      const usersJson = JSON.stringify(state.users || [], null, 2);
      const tmpU = USERS_FILE + '.tmp';
      await fsp.writeFile(tmpU, usersJson, 'utf8');
      await fsp.rename(tmpU, USERS_FILE);
    } catch (err) {
      console.error('[persist users] erro:', err.message);
    }
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
    linhasAgregadas: 0,
    problemas: [],
  };
  const novasSaidas = [];
  const novosAjustes = [];

  // Pre-agrega linhas com mesma (codigo, tamanho) somando quantidades — evita
  // duplicar saídas/ajustes quando o mesmo SKU aparece múltiplas vezes no relatório.
  function aggregarLinhas(rows) {
    const map = new Map();
    let agregadas = 0;
    rows.forEach((row, originalIndex) => {
      const codigo = asInt(row.codigo);
      const tamanho = asTamanho(row.tamanho);
      const quantidade = asInt(row.quantidade);
      if (!codigo || !tamanho || !Number.isFinite(quantidade)) {
        // Inválida — preserva pra reportar erro depois
        map.set('invalid:' + originalIndex, { row: Object.assign({}, row), originalIndex, agregada: false });
        return;
      }
      const key = codigo + '|' + tamanho;
      if (map.has(key)) {
        const existing = map.get(key);
        existing.row.quantidade = (asInt(existing.row.quantidade) || 0) + quantidade;
        existing.agregada = true;
        agregadas++;
      } else {
        map.set(key, { row: Object.assign({}, row), originalIndex, agregada: false });
      }
    });
    result.linhasAgregadas = agregadas;
    return [...map.values()].sort((a, b) => a.originalIndex - b.originalIndex);
  }
  const linhasAgregadas = aggregarLinhas(rows);
  const novosProdutos = [];
  const tamanhosPendentes = new Map();

  function buscarOuCriarProduto(linha, codigo, tipo, cor, descricao, preco) {
    // Produto existente NUNCA é modificado pela importação — preserva tipo/cor/item/preço
    // do cadastro canônico (vindo do ERP_CATALOGO ou cadastrado manualmente).
    let p = state.produtos.find(x => x.codigo === codigo);
    if (p) return p;
    p = novosProdutos.find(x => x.codigo === codigo);
    if (p) return p;
    // Auto-cadastro: se o codigo está no catálogo canônico (ERP_CATALOGO), usa os valores
    // canônicos em vez dos extraídos da descrição do PDF — o catálogo PREVALECE.
    const canonico = ERP_CATALOGO.find(e => e.codigo === codigo);
    let tipoFinal, corFinal;
    if (canonico) {
      tipoFinal = canonico.tipo;
      corFinal = canonico.cor;
    } else {
      if (!tipo || !cor) {
        result.problemas.push({ linha, motivo: 'Não foi possível inferir tipo/cor para o código ' + codigo + ' a partir da descrição "' + descricao + '"' });
        return null;
      }
      tipoFinal = tipo;
      corFinal = cor;
    }
    const item = tipoFinal + '-' + corFinal;
    // Auto-cadastro pré-popula TODOS os tamanhos padrão; tamanhos não mencionados
    // no relatório ainda estarão disponíveis pra movimentação manual depois.
    p = {
      codigo,
      item,
      tipo: tipoFinal,
      cor: corFinal,
      tamanhos: Array.from(TAMANHOS_VALIDOS),
      preco: Number.isFinite(preco) && preco > 0 ? preco : 19.90,
      custom: !canonico,
      autoCadastro: !canonico,
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

  linhasAgregadas.forEach(({ row, originalIndex }) => {
    const linha = originalIndex + 1;
    const codigo = asInt(row.codigo);
    const tamanho = asTamanho(row.tamanho);
    const quantidade = asInt(row.quantidade);
    const tipo = tipoCanonico(asStr(row.tipo));
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

// Apaga ajustes "auto" (contagens iniciais geradas pelo sistema). Para produtos do tipo
// `tipoComManuais`, preserva ajustes manuais (não-auto). Para os demais, apaga TODOS os
// ajustes (zerando a contagem). Usado pra limpeza antes de inserção manual de contagem.
app.post('/api/admin/zerar-contagem-auto', authMiddleware, adminOnly, async (req, res) => {
  const tipoPreservar = String((req.body && req.body.tipoComManuais) || '').toUpperCase().trim();
  const codigosPreservar = new Set(
    state.produtos.filter(p => (p.tipo || '').toUpperCase() === tipoPreservar).map(p => p.codigo)
  );
  const isAuto = (a) => (a.motivo || '').startsWith(CONTAGEM_INICIAL_MOTIVO_PREFIX) || a.origem === 'auto-fix-migration' || a.origem === 'erp-import';
  const antes = state.ajustes.length;
  const removidos = [];
  state.ajustes = state.ajustes.filter(a => {
    if (codigosPreservar.has(a.codigo)) {
      // Para o tipo preservado: remove só os auto, mantém os manuais
      if (isAuto(a)) { removidos.push(a); return false; }
      return true;
    }
    // Para os demais tipos: remove TODOS os ajustes
    removidos.push(a);
    return false;
  });
  // Marca que o seed inicial foi feito — a migração não re-seedará em boots futuros.
  state.seedContagemInicialFeito = true;
  await persist();
  broadcast();
  res.json({
    ok: true,
    removidos: removidos.length,
    preservados: state.ajustes.length,
    tipoComManuaisPreservados: tipoPreservar,
    codigosPreservados: [...codigosPreservar].sort((a,b)=>a-b),
  });
});

// Apaga saídas oriundas de importação do ERP (origem='erp-import'). Saídas manuais
// (registradas via formulário no app) são preservadas.
app.post('/api/admin/zerar-saidas-erp', authMiddleware, adminOnly, async (req, res) => {
  const antes = state.saidas.length;
  const removidas = state.saidas.filter(s => s.origem === 'erp-import');
  state.saidas = state.saidas.filter(s => s.origem !== 'erp-import');
  await persist();
  broadcast();
  res.json({
    ok: true,
    removidas: removidas.length,
    preservadas: state.saidas.length,
    total_antes: antes,
  });
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
