// Adiciona 300 unidades na contagem (qtdContada) para todos os SKUs CM.LISA.
// - Lê data/estoque.json
// - Para cada SKU (produto.tipo === 'CM.LISA') × cada tamanho:
//     ultimaContagem = última ajuste por data/id, ou 0 se inexistente
//     estoqueAtual = entradas - saidas + soma(ajustes.diferenca)
//     novaQtdContada = ultimaContagem + 300
//     diferenca = novaQtdContada - estoqueAtual
//   Cria um novo ajuste com esses valores.
// - Persiste estoque.json.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'estoque.json');
const HOJE = '2026-05-19';
const MOTIVO = 'Acréscimo de 300 un. na contagem (CM.LISA)';
const TIPO_ALVO = 'CM.LISA';
const DELTA = 300;

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const produtos = data.produtos || [];
const entradas = data.entradas || [];
const saidas = data.saidas || [];
const ajustes = data.ajustes || [];

function estoqueSku(codigo, tamanho) {
  let ent = 0, sai = 0, aj = 0;
  for (const e of entradas) if (e.codigo === codigo && e.tamanho === tamanho) ent += e.quantidade;
  for (const s of saidas) if (s.codigo === codigo && s.tamanho === tamanho) sai += s.quantidade;
  for (const a of ajustes) if (a.codigo === codigo && a.tamanho === tamanho) aj += a.diferenca;
  return ent - sai + aj;
}

function ultimaContagemQtd(codigo, tamanho) {
  const list = ajustes.filter(a => a.codigo === codigo && a.tamanho === tamanho);
  if (list.length === 0) return 0;
  const sorted = list.slice().sort((a, b) =>
    (b.data || '').localeCompare(a.data || '') || (b.id || '').localeCompare(a.id || '')
  );
  return sorted[0].qtdContada || 0;
}

const alvos = produtos.filter(p => p.tipo === TIPO_ALVO);
console.log('Produtos CM.LISA encontrados:', alvos.length);
let criados = 0;
for (const p of alvos) {
  for (const t of (p.tamanhos || [])) {
    const ultima = ultimaContagemQtd(p.codigo, t);
    const atual = estoqueSku(p.codigo, t);
    const nova = ultima + DELTA;
    const dif = nova - atual;
    if (dif === 0) {
      console.log('  pula', p.codigo, t, '(diferença 0)');
      continue;
    }
    ajustes.push({
      id: uid(),
      codigo: p.codigo,
      tamanho: t,
      data: HOJE,
      qtdContada: nova,
      qtdAnterior: atual,
      diferenca: dif,
      motivo: MOTIVO,
      origem: 'manual',
    });
    criados++;
    console.log('  +', p.codigo, p.item, t, '-> contagem', ultima, '=>', nova, '(dif', dif + ')');
  }
}

data.ajustes = ajustes;
data.atualizado_em = new Date().toISOString();
fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
console.log('Ajustes criados:', criados);
console.log('Total de ajustes no arquivo:', ajustes.length);
