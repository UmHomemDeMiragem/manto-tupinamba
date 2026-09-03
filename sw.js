/* ==================================================================
   sw.js — Service Worker de cache básico e defensivo
   Protocolo Confidencial · O Manto Tupinambá (ICH/UnB)

   Objetivo único: reduzir o impacto de sinal fraco/instável (paredes de
   concreto do prédio bloqueando 4G) DEPOIS que a página já carregou com
   sucesso pelo menos uma vez — não é um app instalável completo (sem
   manifest.json / ícones), só resiliência de carregamento repetido.

   Estratégia "cache-first": para o documento e para os recursos de CDN
   já usados pelo app, responde do cache quando existe uma cópia local;
   caso contrário busca na rede e guarda uma cópia para a próxima vez.
   Qualquer falha aqui dentro é isolada e não deve derrubar a
   requisição além do que já aconteceria sem Service Worker nenhum.

   Nota de implementação: um Service Worker só pode ser registrado a
   partir de uma URL http(s) cuja resposta tenha um Content-Type de
   script — todos os navegadores recusam registrá-lo a partir de uma
   blob: ou data: URL (violação do próprio algoritmo de registro da
   especificação, testado e confirmado neste projeto: "Failed to
   register a ServiceWorker: The URL protocol of the script (...) is
   not supported"). Por isso este arquivo existe como o único "efeito
   colateral" físico dessa restrição de plataforma — index.html
   continua sendo o único lugar com conteúdo/lógica da aplicação em si;
   este arquivo só contém a rotina de cache, e index.html o registra
   defensivamente (ver função registrarServiceWorkerCache()).
   ================================================================== */
'use strict';

/* Suba este número (v1 -> v2 ...) sempre que quiser forçar todos os
   navegadores a descartar o cache antigo e buscar tudo de novo — por
   exemplo, depois de corrigir um texto do dossiê. Sem isso, "cache-first"
   por padrão mantém servindo a cópia local indefinidamente. */
var CACHE_VERSAO = 'manto-tupinamba-v1';

/* Documento principal + CDNs já usados pelo <head> de index.html.
   Se as versões pinadas dos scripts de CDN mudarem em index.html, vale
   atualizar aqui também — uma URL desatualizada aqui só falha ao tentar
   pré-cachear (sem quebrar nada; ver buscarEArmazenar), então isto é
   uma otimização, não um requisito de correção. */
var URLS_PRE_CACHE = [
  './',
  'index.html',
  'https://cdn.tailwindcss.com',
  'https://unpkg.com/lucide@1.39.0/dist/umd/lucide.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdn.jsdelivr.net/npm/canvas-confetti@1.6.0/dist/confetti.browser.min.js',
  'https://fonts.googleapis.com/css2?family=Cinzel:wght@400;500;600;700;900&family=Inter:wght@300;400;500;600;700;800&display=swap'
];

/* Hosts elegíveis para cache em tempo de uso. fonts.gstatic.com entra aqui
   mesmo sem estar em URLS_PRE_CACHE: os arquivos de fonte de verdade têm
   URLs que só existem depois que o navegador resolve o CSS do Google
   Fonts, então são cacheados sob demanda, na primeira vez que forem
   buscados. */
var HOSTS_CACHEAVEIS = [
  self.location.hostname,
  'cdn.tailwindcss.com',
  'unpkg.com',
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];

/* Busca uma URL e guarda a resposta no cache informado. Scripts/CSS de CDN
   carregados sem o atributo crossorigin (é o caso de todos os <script src>
   deste app) chegam como resposta "opaca" (status 0, .ok === false) mesmo
   quando o download deu certo — por isso o cache aceita .ok OU .type ===
   'opaque', e não seria correto exigir só .ok aqui. */
function buscarEArmazenar(cache, url) {
  var ehMesmaOrigem = url.indexOf('http') !== 0;
  var opcoes = ehMesmaOrigem ? {} : { mode: 'no-cors' };
  return fetch(url, opcoes).then(function (resposta) {
    if (resposta && (resposta.ok || resposta.type === 'opaque')) {
      return cache.put(url, resposta);
    }
  }).catch(function () {
    /* sem rede na primeira instalação, ou CDN indisponível — segue sem essa
       URL; ela ainda pode ser cacheada depois, sob demanda, pelo handler
       de 'fetch' abaixo, na primeira vez que o app pedir esse recurso. */
  });
}

self.addEventListener('install', function (evento) {
  self.skipWaiting();
  evento.waitUntil(
    caches.open(CACHE_VERSAO).then(function (cache) {
      /* cache.addAll() é tudo-ou-nada: uma falha isolada derrubaria o
         cache inteiro. Buscar e guardar cada URL individualmente evita
         isso — o app shell pode ficar disponível offline mesmo que uma
         CDN específica esteja fora do ar no momento da instalação. */
      return Promise.all(URLS_PRE_CACHE.map(function (url) {
        return buscarEArmazenar(cache, url);
      }));
    }).catch(function () { /* Cache Storage indisponível — nada a fazer aqui */ })
  );
});

self.addEventListener('activate', function (evento) {
  evento.waitUntil(
    caches.keys().then(function (nomes) {
      return Promise.all(nomes.map(function (nome) {
        if (nome !== CACHE_VERSAO) { return caches.delete(nome); }
      }));
    }).then(function () {
      return self.clients.claim();
    }).catch(function () { /* silencioso */ })
  );
});

self.addEventListener('fetch', function (evento) {
  var requisicao = evento.request;
  if (requisicao.method !== 'GET') { return; } /* não intercepta POST/etc. */

  var url;
  try { url = new URL(requisicao.url); } catch (erro) { return; }
  if (HOSTS_CACHEAVEIS.indexOf(url.hostname) === -1) { return; } /* deixa passar direto */

  evento.respondWith(
    caches.match(requisicao).then(function (respostaCache) {
      if (respostaCache) { return respostaCache; }
      return fetch(requisicao).then(function (respostaRede) {
        if (respostaRede && (respostaRede.ok || respostaRede.type === 'opaque')) {
          var copia = respostaRede.clone();
          caches.open(CACHE_VERSAO).then(function (cache) { cache.put(requisicao, copia); }).catch(function () {});
        }
        return respostaRede;
      }).catch(function (erroRede) {
        /* Sem cache e sem rede: numa navegação de página, tenta ao menos
           devolver o documento principal já salvo, em vez de um erro cru. */
        if (requisicao.mode === 'navigate') {
          return caches.match('./').then(function (fallback) { return fallback || Promise.reject(erroRede); });
        }
        throw erroRede;
      });
    })
  );
});
