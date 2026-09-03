/* ==================================================================
   lib/edge-tts-client.js — Cliente Node.js do protocolo "Edge Read Aloud"
   Protocolo Confidencial · O Manto Tupinambá (ICH/UnB)

   Porta fiel, para Node.js puro (sem dependências além de 'ws'), da
   lógica real usada pelo pacote Python 'edge-tts' (versão 7.2.8,
   instalado em C:\Users\kauad\AppData\Roaming\Python\Python314\
   site-packages\edge_tts) para falar com o serviço gratuito de TTS da
   Microsoft ("Edge Read Aloud" / Speech Platform consumer endpoint).

   Cada trecho abaixo tem uma referência ao arquivo-fonte Python
   correspondente (drm.py, constants.py, communicate.py, data_classes.py)
   para que qualquer ajuste futuro possa comparar com o original.

   O formato exato de quadro binário de áudio (2 bytes de comprimento de
   cabeçalho + texto do cabeçalho + bytes de áudio) foi CONFIRMADO
   empiricamente conectando de verdade ao serviço com o pacote Python
   instrumentado (não foi só deduzido lendo o código) — ver
   scratchpad/probe_wire_format.py da sessão que criou este arquivo.
   ================================================================== */

'use strict';

const crypto = require('crypto');
const WebSocket = require('ws');

/* ------------------------------------------------------------------
   Constantes (edge_tts/constants.py)
   ------------------------------------------------------------------ */

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const BASE_URL = 'speech.platform.bing.com/consumer/speech/synthesize/readaloud';
const WSS_URL = `wss://${BASE_URL}/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`;

// Mesma versão de Chromium "fingiada" que o edge-tts 7.2.8 usa (constants.py).
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split('.')[0];
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;

const BASE_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' +
    ` (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36` +
    ` Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`,
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'en-US,en;q=0.9',
};

// Nota: NÃO incluímos "Sec-WebSocket-Version" aqui — a biblioteca 'ws' já
// define esse cabeçalho sozinha (valor 13, o mesmo que o edge-tts usa) como
// parte do handshake; duplicá-lo manualmente só arriscaria um cabeçalho
// repetido sem necessidade.
const WSS_HEADERS_BASE = Object.assign(
  {
    Pragma: 'no-cache',
    'Cache-Control': 'no-cache',
    Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
  },
  BASE_HEADERS
);

// Formato de saída: 48kbps CBR mono MP3 — o mesmo que o edge-tts usa.
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

/* ------------------------------------------------------------------
   DRM: geração do token Sec-MS-GEC (edge_tts/drm.py)
   ------------------------------------------------------------------
   O token é um SHA256 de "<ticks><TRUSTED_CLIENT_TOKEN>", onde <ticks> é
   o relógio atual (UTC), convertido para época do Windows (1601-01-01),
   arredondado para baixo aos 5 minutos mais próximos, e expresso em
   intervalos de 100ns (formato Windows FILETIME). Ver comentário extenso
   sobre precisão de ponto flutuante mais abaixo em generateSecMsGec(). */

const WIN_EPOCH = 11644473600; // segundos entre 1601-01-01 e 1970-01-01

// Espelha o atributo de classe `DRM.clock_skew_seconds` do Python: um
// ajuste de relógio que persiste (por processo) depois de uma correção via
// handleClientResponseError. Em uma function serverless "quente" (mesma
// instância reaproveitada entre requisições), esse estado sobrevive entre
// chamadas, exatamente como no processo Python de vida longa do CLI.
let clockSkewSeconds = 0;

function getUnixTimestamp() {
  return Date.now() / 1000 + clockSkewSeconds;
}

function generateSecMsGec() {
  // Réplica exata, operação por operação, de DRM.generate_sec_ms_gec().
  //
  // Nota de precisão: Python usa datetime.timestamp() (precisão de
  // microssegundos); aqui usamos Date.now()/1000 (precisão de
  // milissegundos). Isso NÃO afeta o resultado final: o passo seguinte
  // (`ticks -= ticks % 300`) descarta toda a parte fracionária de
  // qualquer forma, arredondando para baixo ao múltiplo de 300s mais
  // próximo — o valor final depende só de "em qual balde de 5 minutos"
  // caímos, não dos milissegundos/microssegundos exatos. A partir daí,
  // as duas linguagens fazem aritmética IEEE-754 de 64 bits idêntica
  // (dobra/double), então o mesmo inteiro de entrada produz o mesmo
  // resultado bit a bit em ambas — validado empiricamente em
  // scratchpad/check_gec_hash.js/.py (mesmo hash para o mesmo instante
  // congelado) e depois validado de ponta a ponta contra o serviço real.
  let ticks = getUnixTimestamp();
  ticks += WIN_EPOCH;
  ticks -= ticks % 300;
  ticks *= 1e9 / 100; // S_TO_NS / 100, igual ao Python

  const strToHash = `${Math.round(ticks)}${TRUSTED_CLIENT_TOKEN}`;
  return crypto.createHash('sha256').update(strToHash, 'ascii').digest('hex').toUpperCase();
}

function generateMuid() {
  return crypto.randomBytes(16).toString('hex').toUpperCase();
}

function headersWithMuid(headers) {
  return Object.assign({}, headers, { Cookie: `muid=${generateMuid()};` });
}

function parseRfc2616Date(dateStr) {
  const parsed = new Date(dateStr);
  const t = parsed.getTime();
  return Number.isNaN(t) ? null : t / 1000;
}

// Réplica de DRM.handle_client_response_error: usa o cabeçalho `Date` da
// resposta 403 do servidor para corrigir o relógio local e tentar de novo.
function adjustClockSkewFromServerDate(serverDateHeader) {
  if (!serverDateHeader) return false;
  const serverDate = parseRfc2616Date(serverDateHeader);
  if (serverDate === null) return false;
  const clientDate = getUnixTimestamp();
  clockSkewSeconds += serverDate - clientDate;
  return true;
}

/* ------------------------------------------------------------------
   Utilitários diversos (edge_tts/communicate.py)
   ------------------------------------------------------------------ */

function connectId() {
  return crypto.randomUUID().replace(/-/g, '');
}

// Réplica de communicate.date_to_string(): formato de data ao estilo
// JavaScript de navegador em UTC, ex.:
// "Wed Sep 03 2026 15:27:48 GMT+0000 (Coordinated Universal Time)".
function dateToString() {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCDate())} ${d.getUTCFullYear()} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`
  );
}

// Réplica de TTSConfig.__post_init__ (data_classes.py): transforma
// "pt-BR-ThalitaMultilingualNeural" em
// "Microsoft Server Speech Text to Speech Voice (pt-BR, ThalitaMultilingualNeural)"
// — é essa forma longa que vai dentro do SSML, não o nome curto.
function resolveVoiceName(shortVoice) {
  const m = /^([a-z]{2,})-([A-Z]{2,})-(.+Neural)$/.exec(shortVoice);
  if (!m) return shortVoice;
  let [, lang, region, name] = m;
  const dashIdx = name.indexOf('-');
  if (dashIdx !== -1) {
    region = `${region}-${name.slice(0, dashIdx)}`;
    name = name.slice(dashIdx + 1);
  }
  return `Microsoft Server Speech Text to Speech Voice (${lang}-${region}, ${name})`;
}

// Réplica de remove_incompatible_characters: troca por espaço os
// caracteres de controle nas faixas 0-8, 11-12, 14-31 (mantém tab/LF/CR).
function removeIncompatibleCharacters(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ');
}

// Réplica de xml.sax.saxutils.escape(data) SEM o dicionário de entidades
// extra (edge-tts não passa nenhum) — ordem exata: & , depois > , depois <.
function escapeXml(text) {
  return text.replace(/&/g, '&amp;').replace(/>/g, '&gt;').replace(/</g, '&lt;');
}

/* ------------------------------------------------------------------
   split_text_by_byte_length — divide o texto em pedaços de no máximo
   `byteLength` bytes UTF-8, preferindo cortar em espaço/quebra de linha,
   nunca no meio de um caractere UTF-8 multibyte nem de uma entidade XML
   (&amp; etc). Porta fiel de communicate.py.

   Com o limite de 700 caracteres imposto na camada HTTP (api/tts.js) e o
   limite de 4096 bytes usado aqui, isso nunca deveria realmente dividir
   nada na prática (o pior caso realista de expansão por escape XML,
   700 caracteres todos "&", dá 3500 bytes) — mas mantemos a lógica
   completa por fidelidade ao protocolo original e como salvaguarda caso
   o limite de caracteres mude no futuro.
   ------------------------------------------------------------------ */

function findLastNewlineOrSpaceWithinLimit(buf, limit) {
  let splitAt = buf.lastIndexOf(0x0a, limit - 1); // '\n'
  if (splitAt < 0) {
    splitAt = buf.lastIndexOf(0x20, limit - 1); // ' '
  }
  return splitAt;
}

const UTF8_STRICT_DECODER = new TextDecoder('utf-8', { fatal: true });

function isValidUtf8(buf) {
  try {
    UTF8_STRICT_DECODER.decode(buf);
    return true;
  } catch (_err) {
    return false;
  }
}

function findSafeUtf8SplitPoint(buf) {
  let splitAt = buf.length;
  while (splitAt > 0) {
    if (isValidUtf8(buf.subarray(0, splitAt))) return splitAt;
    splitAt -= 1;
  }
  return splitAt;
}

function adjustSplitPointForXmlEntity(buf, splitAtIn) {
  let splitAt = splitAtIn;
  while (splitAt > 0 && buf.subarray(0, splitAt).includes(0x26 /* & */)) {
    const ampersandIndex = buf.lastIndexOf(0x26, splitAt - 1);
    if (buf.subarray(ampersandIndex, splitAt).includes(0x3b /* ; */)) {
      break;
    }
    splitAt = ampersandIndex;
  }
  return splitAt;
}

function stripBytes(buf) {
  return Buffer.from(buf.toString('utf-8').trim(), 'utf-8');
}

function splitTextByByteLength(text, byteLength) {
  if (byteLength <= 0) throw new Error('byteLength must be greater than 0');
  let buf = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf-8');
  const chunks = [];

  while (buf.length > byteLength) {
    let splitAt = findLastNewlineOrSpaceWithinLimit(buf, byteLength);
    if (splitAt < 0) {
      splitAt = findSafeUtf8SplitPoint(buf);
    }
    splitAt = adjustSplitPointForXmlEntity(buf, splitAt);
    if (splitAt < 0) {
      throw new Error("Maximum byte length is too small or invalid text structure near '&' or invalid UTF-8");
    }

    const chunk = stripBytes(buf.subarray(0, splitAt));
    if (chunk.length > 0) chunks.push(chunk);

    buf = buf.subarray(splitAt > 0 ? splitAt : 1);
  }

  const remaining = stripBytes(buf);
  if (remaining.length > 0) chunks.push(remaining);

  return chunks;
}

/* ------------------------------------------------------------------
   Montagem das mensagens do protocolo (communicate.py)
   ------------------------------------------------------------------ */

function mkssml(voiceLongName, rate, pitch, volume, escapedTextChunk) {
  return (
    "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
    `<voice name='${voiceLongName}'>` +
    `<prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>` +
    `${escapedTextChunk}` +
    '</prosody></voice></speak>'
  );
}

function buildSpeechConfigMessage() {
  return (
    `X-Timestamp:${dateToString()}\r\n` +
    'Content-Type:application/json; charset=utf-8\r\n' +
    'Path:speech.config\r\n\r\n' +
    '{"context":{"synthesis":{"audio":{"metadataoptions":{' +
    '"sentenceBoundaryEnabled":"true","wordBoundaryEnabled":"false"' +
    '},"outputFormat":"' +
    OUTPUT_FORMAT +
    '"}}}}\r\n'
  );
}

function buildSsmlMessage(ssml) {
  return (
    `X-RequestId:${connectId()}\r\n` +
    'Content-Type:application/ssml+xml\r\n' +
    `X-Timestamp:${dateToString()}Z\r\n` + // "Z" após o fuso é assim mesmo no original (bug conhecido do Edge, preservado de propósito)
    'Path:ssml\r\n\r\n' +
    ssml
  );
}

/* ------------------------------------------------------------------
   Parsing das respostas do WebSocket
   ------------------------------------------------------------------ */

function parseHeaderLines(str) {
  const headers = {};
  for (const line of str.split('\r\n')) {
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    headers[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return headers;
}

// Mensagens TEXT: "Header:Valor\r\n...\r\n\r\n<corpo opcional>"
function parseTextMessage(str) {
  const sepIdx = str.indexOf('\r\n\r\n');
  const headerPart = sepIdx === -1 ? str : str.slice(0, sepIdx);
  return parseHeaderLines(headerPart);
}

// Mensagens BINARY: 2 bytes big-endian (comprimento do cabeçalho) + texto
// do cabeçalho + bytes de áudio crus. Formato confirmado empiricamente
// (ver cabeçalho do arquivo) — ao contrário da leitura ingênua do código
// Python (que reaproveita get_headers_and_data de um jeito que corrompe
// só a PRIMEIRA chave do cabeçalho, sem efeito prático porque essa chave
// nunca é lida), aqui implementamos a fatia correta desde o início:
// texto do cabeçalho = bytes [2, 2+headerLength); áudio = bytes a partir
// de 2+headerLength.
function parseBinaryMessage(buf) {
  if (buf.length < 2) {
    throw new Error('Binary message too short to contain a header length');
  }
  const headerLength = buf.readUInt16BE(0);
  if (2 + headerLength > buf.length) {
    throw new Error('Header length exceeds binary message size');
  }
  const headerText = buf.subarray(2, 2 + headerLength).toString('utf-8');
  const headers = parseHeaderLines(headerText);
  const audio = buf.subarray(2 + headerLength);
  return { headers, audio };
}

/* ------------------------------------------------------------------
   synthesizeChunk — abre UMA conexão WebSocket, envia config+SSML para
   um único pedaço de texto (já dentro do limite de bytes) e resolve com
   um Buffer de áudio MP3. Cada pedaço usa sua própria conexão nova, tal
   qual Communicate.__stream() no Python (nunca reaproveita o socket
   entre pedaços).
   ------------------------------------------------------------------ */

function synthesizeChunk(escapedTextChunk, options) {
  const { voice, rate, pitch, volume, timeoutMs } = options;

  return new Promise((resolve, reject) => {
    const url =
      `${WSS_URL}&ConnectionId=${connectId()}` +
      `&Sec-MS-GEC=${generateSecMsGec()}` +
      `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;

    let ws;
    try {
      ws = new WebSocket(url, {
        headers: headersWithMuid(WSS_HEADERS_BASE),
        perMessageDeflate: true,
        handshakeTimeout: timeoutMs,
      });
    } catch (err) {
      reject(Object.assign(new Error(`Failed to open WebSocket: ${err.message}`), { cause: err }));
      return;
    }

    const audioParts = [];
    let audioReceived = false;
    let settled = false;

    const timer = setTimeout(() => {
      finish(new Error('Timeout waiting for the TTS service response'));
    }, timeoutMs);

    function finish(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.removeAllListeners();
        ws.terminate();
      } catch (_e) {
        /* conexão já fechada — ignora */
      }
      if (err) reject(err);
      else resolve(Buffer.concat(audioParts));
    }

    ws.on('open', () => {
      try {
        ws.send(buildSpeechConfigMessage());
        const voiceLongName = resolveVoiceName(voice);
        const ssml = mkssml(voiceLongName, rate, pitch, volume, escapedTextChunk);
        ws.send(buildSsmlMessage(ssml));
      } catch (err) {
        finish(err);
      }
    });

    ws.on('unexpected-response', (_req, res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const bodyText = Buffer.concat(chunks).toString('utf-8').slice(0, 500);
        const err = new Error(`TTS service returned HTTP ${res.statusCode} during WebSocket handshake: ${bodyText}`);
        err.statusCode = res.statusCode;
        err.serverDate = res.headers && res.headers.date;
        finish(err);
      });
      res.on('error', () => {
        const err = new Error(`TTS service returned HTTP ${res.statusCode} during WebSocket handshake`);
        err.statusCode = res.statusCode;
        err.serverDate = res.headers && res.headers.date;
        finish(err);
      });
    });

    ws.on('message', (data, isBinary) => {
      try {
        if (!isBinary) {
          const headers = parseTextMessage(data.toString('utf-8'));
          const path = headers.Path;
          if (path === 'turn.end') {
            finish(audioReceived ? null : new Error('No audio was received from the TTS service'));
          } else if (path === 'turn.start' || path === 'response' || path === 'audio.metadata') {
            // nada a fazer — não precisamos de metadados de timing para este uso
          } else {
            finish(new Error(`Unexpected message Path from TTS service: ${path}`));
          }
          return;
        }

        const { headers, audio } = parseBinaryMessage(data);
        if (headers.Path !== 'audio') {
          finish(new Error(`Unexpected binary message Path from TTS service: ${headers.Path}`));
          return;
        }
        const contentType = headers['Content-Type'];
        if (contentType === 'audio/mpeg') {
          if (audio.length === 0) {
            finish(new Error('Received an empty audio/mpeg chunk'));
            return;
          }
          audioParts.push(Buffer.from(audio));
          audioReceived = true;
        } else if (contentType === undefined) {
          if (audio.length !== 0) {
            finish(new Error('Received binary data with no Content-Type header'));
          }
          // caso contrário: marcador vazio benigno, ignora (igual ao Python)
        } else {
          finish(new Error(`Unexpected audio Content-Type from TTS service: ${contentType}`));
        }
      } catch (err) {
        finish(err);
      }
    });

    ws.on('error', (err) => {
      finish(err instanceof Error ? err : new Error(String(err)));
    });

    ws.on('close', (code, reasonBuf) => {
      if (!settled) {
        const reason = reasonBuf ? reasonBuf.toString('utf-8') : '';
        finish(new Error(`WebSocket closed before the audio finished streaming (code=${code}${reason ? `, reason=${reason}` : ''})`));
      }
    });
  });
}

// Tenta uma vez; se o serviço responder 403 no handshake (relógio local
// fora de sincronia), corrige o relógio a partir do cabeçalho Date da
// resposta e tenta de novo uma única vez — réplica de
// Communicate.stream() (bloco except aiohttp.ClientResponseError).
async function synthesizeChunkWithRetry(escapedTextChunk, options) {
  try {
    return await synthesizeChunk(escapedTextChunk, options);
  } catch (err) {
    if (err && err.statusCode === 403) {
      adjustClockSkewFromServerDate(err.serverDate);
      return synthesizeChunk(escapedTextChunk, options);
    }
    throw err;
  }
}

/* ------------------------------------------------------------------
   API pública do módulo
   ------------------------------------------------------------------ */

const DEFAULT_TIMEOUT_MS = 15000;

/**
 * Sintetiza `text` em áudio MP3 usando o serviço gratuito "Edge Read
 * Aloud" da Microsoft, com a mesma voz/qualidade usada no resto do app.
 *
 * @param {string} text texto puro (não escapado), já validado pelo chamador
 * @param {object} [opts]
 * @param {string} [opts.voice] nome curto da voz, ex. "pt-BR-ThalitaMultilingualNeural"
 * @param {string} [opts.rate] ex. "-15%"
 * @param {string} [opts.pitch] ex. "+0Hz"
 * @param {string} [opts.volume] ex. "+0%"
 * @param {number} [opts.timeoutMs] timeout por conexão (cada pedaço de texto)
 * @returns {Promise<Buffer>} MP3 completo (concatenação de todos os pedaços)
 */
async function synthesizeToMp3(text, opts = {}) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');

  const voice = opts.voice || 'pt-BR-ThalitaMultilingualNeural';
  const rate = opts.rate || '-15%';
  const pitch = opts.pitch || '+0Hz';
  const volume = opts.volume || '+0%';
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  const cleaned = escapeXml(removeIncompatibleCharacters(text));
  const chunks = splitTextByByteLength(cleaned, 4096);

  if (chunks.length === 0) {
    throw new Error('text has no synthesizable content after cleaning');
  }

  const audioBuffers = [];
  for (const chunkBuf of chunks) {
    // eslint-disable-next-line no-await-in-loop
    const audio = await synthesizeChunkWithRetry(chunkBuf.toString('utf-8'), {
      voice,
      rate,
      pitch,
      volume,
      timeoutMs,
    });
    audioBuffers.push(audio);
  }

  return Buffer.concat(audioBuffers);
}

module.exports = {
  // API principal
  synthesizeToMp3,
  // Exportado para os testes isolados (scratchpad) e para eventual
  // depuração — não é a superfície pública "oficial" do módulo.
  _internal: {
    generateSecMsGec,
    getUnixTimestamp,
    resolveVoiceName,
    escapeXml,
    removeIncompatibleCharacters,
    splitTextByByteLength,
    dateToString,
    connectId,
    mkssml,
    parseHeaderLines,
    parseTextMessage,
    parseBinaryMessage,
    synthesizeChunk,
    adjustClockSkewFromServerDate,
    WSS_URL,
    TRUSTED_CLIENT_TOKEN,
    SEC_MS_GEC_VERSION,
  },
};
