# Protocolo Confidencial — O Manto Tupinambá

Duas aplicações web de página única (SPA), sem build, para uma aula de Filosofia
Moderna/Estética na UnB (ICH, curadoria da Profa. Dra. Priscila Rossinetti Rufinoni)
sobre o Manto Tupinambá e sua trajetória entre a razão barroca europeia e a
crítica contemporânea à colonialidade.

- **Produção (Vercel):** https://manto-tupinamba.vercel.app
- **Produção (GitHub Pages, espelho estático):** https://umhomemdemiragem.github.io/manto-tupinamba/

## As duas aplicações

| Arquivo | Nome | O quê |
|---|---|---|
| `index.html` | **Protocolo Confidencial** | 4 módulos: Escuta do Manto (ambiência + narração), O Desafio da Banca (envelopes com casos documentais), Oficina do Avaliador (wizard de redação de item Certo/Errado, exporta PDF), Sincronias Críticas (linha do tempo comparada). |
| `quadro-evidencias.html` | **O Quadro de Evidências** | Dinâmica alternativa/complementar: mural investigativo onde o aluno fixa imagens, conecta com barbante e anota a interpretação; exporta o quadro montado em PNG. |

Ambas: mesma identidade visual, mesmo conjunto de imagens histórico-verificadas
(licenças de uso documentadas em cada crédito), mesma narração pré-gravada
(voz neural `pt-BR-ThalitaMultilingualNeural`, `-15%` de ritmo, via `edge-tts`),
autosave em `localStorage` (nada é enviado a servidor), e um Service Worker
(`sw.js`) para resiliência offline/sinal fraco.

O `index.html` e o `quadro-evidencias.html` se referenciam mutuamente no
cabeçalho — são pensados como **alternativas**, não como uma sequência
obrigatória (~15–20 min e ~10–15 min, respectivamente).

## Arquitetura

- **100% client-side, um arquivo por app.** Tailwind (Play CDN), Lucide Icons,
  Google Fonts (Cinzel + Inter), jsPDF e canvas-confetti via `<script defer>`
  de CDN — sem etapa de build, sem `node_modules` na aplicação em si.
- **Único componente de backend:** `api/tts.js`, uma Vercel Serverless
  Function que gera narração sob demanda para texto digitado pelo aluno
  (ex.: o wizard da Oficina), usando o mesmo protocolo "Edge Read Aloud" via
  `lib/edge-tts-client.js` (porta JS fiel do pacote Python `edge-tts`).
  - Sem chave/segredo de API (o protocolo é público/reverso).
  - Limite de 700 caracteres por requisição, cooldown de 4s por IP, timeout
    interno de 11s (com folga sob o `maxDuration: 15` da Vercel).
  - **Só existe na Vercel.** No GitHub Pages (sem functions), o app cai
    automaticamente para `speechSynthesis` do navegador — nenhuma funcionalidade
    quebra, a voz apenas fica menos natural para texto digitado ao vivo.
- **QR code vendorizado** (sem dependência externa) para o "Modo Projetor".

## Rodando localmente

Não há passo de build. Para o `index.html`/`quadro-evidencias.html` sozinhos,
basta um servidor estático (o navegador bloqueia alguns recursos em `file://`):

```bash
python -m http.server 8934
```

Para testar também o proxy de narração (`api/tts.js`), use a CLI da Vercel:

```bash
npm install
vercel dev
```

## Deploy

- **Vercel:** auto-deploy a cada push em `main` (projeto já conectado ao
  repositório GitHub). `package.json` declara `ws` como dependência — a
  Vercel builda a function automaticamente, nada manual é necessário.
- **GitHub Pages:** auto-deploy a partir de `main` (Settings → Pages já
  configurado). Como o Pages não roda functions, `api/tts.js` simplesmente
  não existe nesse ambiente — o fallback de `speechSynthesis` cobre isso.

### Um detalhe importante: cache do Service Worker

`sw.js` usa uma estratégia cache-first para resiliência offline. Isso quer
dizer que **qualquer visitante que já abriu o site antes vai continuar vendo
a versão antiga em cache**, mesmo depois de um novo deploy — até que a
constante `CACHE_VERSAO` no topo de `sw.js` seja incrementada (`v4` → `v5`
etc.). **Sempre que alterar `index.html` ou `quadro-evidencias.html`, bump
essa versão no mesmo commit/PR** — do contrário o conteúdo pode nunca chegar
a alunos que já visitaram o link antes (inclusive durante testes locais: o
Service Worker também é registrado em `localhost`).

## Conteúdo e imagens

Todo texto histórico tem procedência checada (fontes citadas inline: museus,
Wikimedia Commons, entrevistas, historiografia acadêmica) e toda imagem
embutida (como `data:` URI, para o app funcionar 100% offline após o primeiro
carregamento) tem sua licença documentada junto ao crédito — a maioria é
domínio público ou CC BY/BY-SA com atribuição, verificada individualmente
antes de ser incluída, não apenas herdada de pesquisa de terceiros.

## Créditos

Desenvolvido por [@arvorekaua](https://www.instagram.com/arvorekaua/) com o
Claude Code, para a disciplina de Estética/Filosofia Moderna do
Departamento de Filosofia (ICH/UnB), curadoria da Profa. Dra. Priscila
Rossinetti Rufinoni.
