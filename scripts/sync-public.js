// Sincroniza os HTML canônicos pro backend/public (o que o Render publica).
// Agora é CÓPIA SIMPLES: os arquivos detectam o host sozinhos (localhost em dev,
// mesmo host quando hospedado), então não precisa mais trocar a URL da API.
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..', '..');   // pasta Stack_n3xus
const pub = path.join(__dirname, '..', 'public');
const arquivos = ['stack-nexus-app-final.html', 'stack-nexus-login.html', 'stack-nexus-onboarding.html'];
let ok = 0;
for (const f of arquivos) {
  const de = path.join(raiz, f), para = path.join(pub, f);
  if (!fs.existsSync(de)) { console.warn('!! não achei', f, '- pulando'); continue; }
  fs.copyFileSync(de, para); ok++;
  console.log('sync', f);
}
console.log('[sync-public] ' + ok + ' arquivo(s) copiado(s) para public/.');
