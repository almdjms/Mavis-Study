import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage,
  Browsers
} from '@whiskeysockets/baileys';
import P from 'pino';
import fs from 'fs';
import readline from 'readline';
import { spawn } from 'child_process';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import express from 'express';

const app = express();

app.get('/', (req, res) => {
  res.send('Bot activo');
});

app.listen(process.env.PORT || 3000);

// ━━━━━━━ CONFIGURACIÓN DE RUTAS ━━━━━━━
const SESSION_PATH = './auth';
const TEMP_DIR = './tmp';
const CACHE_DIR = './cache';

const AUDIO_CACHE = path.join(CACHE_DIR, 'audio');
const VIDEO_CACHE = path.join(CACHE_DIR, 'video');

const GACHA_PATH = './gacha';
const GACHA_IMAGES = path.join(GACHA_PATH, 'images');
const GACHA_VIDEOS = path.join(GACHA_PATH, 'videos');
const IMPORT_PATH = path.join(GACHA_PATH, 'import');
const CHARACTERS_FILE = path.join(GACHA_PATH, 'characters.json');
const VIDEOS_FILE = path.join(GACHA_PATH, 'videos.json');
const SERIES_DIR = path.join(GACHA_PATH, 'series');

const DB_FILE = './database.json';

// Crear carpetas necesarias
for (const dir of [
TEMP_DIR,
AUDIO_CACHE,
VIDEO_CACHE,
'./subbots',
GACHA_PATH,
GACHA_IMAGES,
GACHA_VIDEOS,
IMPORT_PATH,
SERIES_DIR
]) {
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ━━━━━━━ BASE DE DATOS ━━━━━━━
let db = {
  users: {},
  banners: {},
  subbots: {},
  groups: {},
  prefix: '/',
  globalOff: false,
  stats: { totalCommands: 0 },
  globalCooldowns: { vote: {} }
};

if (fs.existsSync(DB_FILE)) {
  try {
    db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf-8')) };
  } catch {}
}

function saveDB() {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); } catch (e) { console.error('Error al guardar DB:', e); }
}
setInterval(saveDB, 30000);

function initUser(sender, pushName) {

  if (!db.users[sender]) {

    db.users[sender] = {
      name: pushName || 'Usuario',
      totalCommands: 0,
      favCommands: {},
      xp: 0,
      level: 1,
      messages: 0
    };

  } else {

    db.users[sender].name =
      pushName || db.users[sender].name;

    if (!db.users[sender].favCommands)
      db.users[sender].favCommands = {};

    if (typeof db.users[sender].xp !== 'number')
      db.users[sender].xp = 0;

    if (typeof db.users[sender].level !== 'number')
      db.users[sender].level = 1;

    if (typeof db.users[sender].messages !== 'number')
      db.users[sender].messages = 0;
  }

  return db.users[sender];
}

function initGroup(jid) {
  if (!db.groups[jid]) db.groups[jid] = {};
  const g = db.groups[jid];
  if (!g.muted) g.muted = [];
  if (typeof g.antilink !== 'boolean') g.antilink = false;
  if (!g.totalMessages) g.totalMessages = 0;
  if (!g.members) g.members = {};
  if (typeof g.off !== 'boolean') g.off = false;
  if (!g.economy) g.economy = {};
  if (!g.cooldowns) g.cooldowns = {};
  if (!g.harems) g.harems = {};
  return g;
}

function getGroupEconomy(groupId, sender) {
  const g = initGroup(groupId);
  if (!g.economy[sender]) {
    g.economy[sender] = { coins: 10000, bank: 0, lastWork: 0, lastSlut: 0, lastCrime: 0, lastDaily: 0, timeReduction: 0 };
  }
  return g.economy[sender];
}

function getGroupCooldowns(groupId, sender) {
  const g = initGroup(groupId);
  if (!g.cooldowns[sender]) {
    g.cooldowns[sender] = { rw: 0, claim: 0, work: 0, slut: 0, crime: 0, daily: 0 };
  }
  return g.cooldowns[sender];
}

// ━━━━━━━ GACHA LOCAL (CACHÉ Y NUEVO SISTEMA) ━━━━━━━
let charactersCache = [];
let characterMap = new Map();   // clave: name.toLowerCase() -> character
let characterKeyMap = new Map(); // clave: key -> character
let imageCache = new Map();
global.ownerIndex = {}; // groupId -> { userId: Set<characterKey> }

function loadCharactersCache() {
  try {
    charactersCache = JSON.parse(fs.readFileSync(CHARACTERS_FILE, 'utf8'));
    characterMap.clear();
    characterKeyMap.clear();
    for (const c of charactersCache) {
      characterMap.set(c.name.toLowerCase(), c);
      characterKeyMap.set(c.key, c);
      if (!c.claimedBy) c.claimedBy = {};
      if (typeof c.claimedBy !== 'object') c.claimedBy = {};
    }
    buildOwnerIndex();
  } catch { charactersCache = []; }
}
loadCharactersCache();

function saveCharacters() {
  try { fs.writeFileSync(CHARACTERS_FILE, JSON.stringify(charactersCache, null, 2)); } catch (e) { console.error('Error guardando characters.json:', e); }
}

function buildOwnerIndex() {
  global.ownerIndex = {};
  for (const c of charactersCache) {
    if (!c.claimedBy) continue;
    for (const [groupId, claimData] of Object.entries(c.claimedBy)) {
      if (!claimData || !claimData.user) continue;
      if (!global.ownerIndex[groupId]) global.ownerIndex[groupId] = {};
      if (!global.ownerIndex[groupId][claimData.user]) global.ownerIndex[groupId][claimData.user] = new Set();
      global.ownerIndex[groupId][claimData.user].add(c.key);
    }
  }
}

function getCharacterImages(key) {
  if (!fs.existsSync(GACHA_IMAGES)) return [];
  return fs.readdirSync(GACHA_IMAGES).filter(f => f.startsWith(key + '_'));
}
function getCharacterImage(char) {
  const imgs = getCharacterImages(char.key);
  if (!imgs.length) return null;
  return path.join(GACHA_IMAGES, imgs[Math.floor(Math.random() * imgs.length)]);
}

function preloadImages() {
  if (!fs.existsSync(GACHA_IMAGES)) return;
  for (const file of fs.readdirSync(GACHA_IMAGES)) {
    const fp = path.join(GACHA_IMAGES, file);
    try { imageCache.set(fp, fs.readFileSync(fp)); } catch {}
  }
}
preloadImages();

// ━━━━━━━ SISTEMA DE SERIES ━━━━━━━
const seriesCache = new Map(); // serieName -> { name, characters: Set<key> }

function loadSeries() {
  seriesCache.clear();
  if (!fs.existsSync(SERIES_DIR)) return;
  const files = fs.readdirSync(SERIES_DIR).filter(f => f.endsWith('.json'));
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(SERIES_DIR, file), 'utf8'));
      if (data.name && Array.isArray(data.characters)) {
        const validKeys = new Set();
        for (const key of data.characters) {
          if (characterKeyMap.has(key)) validKeys.add(key);
        }
        seriesCache.set(data.name.toLowerCase(), { name: data.name, characters: validKeys });
      }
    } catch {}
  }
}
loadSeries();

// ━━━━━━━ VIDEOS LOCALES ━━━━━━━
function getCharacterVideos(key) {
  if (!fs.existsSync(GACHA_VIDEOS)) return [];
  return fs.readdirSync(GACHA_VIDEOS).filter(f => f.startsWith(key + '_'));
}
function getCharacterVideo(key) {
  const vids = getCharacterVideos(key);
  if (!vids.length) return null;
  return path.join(GACHA_VIDEOS, vids[Math.floor(Math.random() * vids.length)]);
}

// ━━━━━━━ HELPERS ━━━━━━━
const OWNER_NUMBER = '39604497432739@lid';
function md5(s) { return crypto.createHash('md5').update(s).digest('hex'); }
function resetSession() { try { fs.rmSync(SESSION_PATH, { recursive: true, force: true }); } catch {} }
function askNumber() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(r => rl.question('Número (569XXXXXXXX): ', n => { rl.close(); r(n.replace(/[^0-9]/g, '')); }));
}

// ━━━━━━━ YT‑DLP ━━━━━━━
function ytDlpExec(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => err += d);
    proc.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(err.trim())));
    proc.on('error', reject);
  });
}
async function ytDlpGetInfo(q) {
  const raw = await ytDlpExec(['-j', '--no-playlist', `ytsearch1:${q}`]);
  return JSON.parse(raw);
}
async function ytDlpDownloadToFile(url, dest, opts = {}) {
  const args = ['-o', dest, '--no-playlist'];
  if (opts.audio) args.push('-f', 'bestaudio', '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '192K');
  else args.push('-f', 'bv*[height<=720]+ba/b[height<=720]');
  args.push(url);
  await ytDlpExec(args);
  const base = path.basename(dest, path.extname(dest));
  const dir = path.dirname(dest);
  const files = fs.readdirSync(dir).filter(f => f.startsWith(base));
  if (!files.length) throw new Error('Archivo no generado');
  return path.join(dir, files[0]);
}

// ━━━━━━━ MEDIA DOWNLOADERS ━━━━━━━
async function handleTomp3(sock, msg) {
  const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  if (!quoted?.videoMessage) return sock.sendMessage(msg.key.remoteJid, { text: '◇ Debes citar un video usando /tomp3' }, { quoted: msg });
  await sock.sendMessage(msg.key.remoteJid, { text: 'creando...' }, { quoted: msg });
  try {
    const videoBuffer = await downloadMediaMessage({ key: msg.key, message: quoted }, 'buffer', {});
    const input = path.join(TEMP_DIR, `vid_${Date.now()}.mp4`);
    const output = path.join(TEMP_DIR, `aud_${Date.now()}.mp3`);
    fs.writeFileSync(input, videoBuffer);
    await new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', ['-i', input, '-vn', '-acodec', 'libmp3lame', '-b:a', '320k', output], { stdio: 'pipe' });
      proc.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg error')));
      proc.on('error', reject);
    });
    await sock.sendMessage(msg.key.remoteJid, { audio: fs.readFileSync(output), mimetype: 'audio/mpeg', ptt: false }, { quoted: msg });
    fs.unlinkSync(input); fs.unlinkSync(output);
  } catch (e) { await sock.sendMessage(msg.key.remoteJid, { text: '❌ Error al convertir.' }, { quoted: msg }); }
}

async function handleTt(sock, msg, url) {
  await sock.sendMessage(msg.key.remoteJid, { text: '⏳ Descargando TikTok...' }, { quoted: msg });
  try {
    const json = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`).then(r => r.json());
    if (json?.code === 0 && json.data?.play) {
      const vUrl = json.data.play || json.data.hdplay;
      const buffer = Buffer.from(await (await fetch(vUrl)).arrayBuffer());
      const caption = `❀ Título » ${json.data.title || ''}\n> ❒ Vistas » ${json.data.play_count || 0}\n> ✰ Likes » ${json.data.digg_count || 0}\n> ✐ Música » ${json.data.music_info?.title || 'N/A'}`;
      await sock.sendMessage(msg.key.remoteJid, { video: buffer, caption, mimetype: 'video/mp4' }, { quoted: msg });
      return;
    }
    throw new Error('API caída');
  } catch (e) { await sock.sendMessage(msg.key.remoteJid, { text: '● Error al descargar el video de TikTok' }, { quoted: msg }); }
}

async function handleMp4(sock, msg, input) {
  await sock.sendMessage(msg.key.remoteJid, { text: '⏳ Buscando video...' }, { quoted: msg });
  try {
    let urlToDownload = input, title = '', thumbnail = '', uploader = '';
    if (!input.startsWith('http://') && !input.startsWith('https://')) {
      const info = await ytDlpGetInfo(input);
      if (!info) throw new Error('No encontrado');
      urlToDownload = info.webpage_url; title = info.title;
      thumbnail = info.thumbnail; uploader = info.uploader;
    } else {
      const info = await ytDlpGetInfo(urlToDownload);
      title = info.title; thumbnail = info.thumbnail; uploader = info.uploader;
    }
    const cacheKey = md5(urlToDownload);
    const cachePath = path.join(VIDEO_CACHE, `${cacheKey}.mp4`);
    if (fs.existsSync(cachePath)) {
      if (thumbnail) {
        try {
          const thumbBuffer = Buffer.from(await (await fetch(thumbnail)).arrayBuffer());
          await sock.sendMessage(msg.key.remoteJid, { image: thumbBuffer, caption: `「✦」Descargando *<${title}>*\n> ✐ Canal » *${uploader || 'Desconocido'}*\n> Calidad: 720p (caché)`, mimetype: 'image/jpeg' }, { quoted: msg });
        } catch {}
      }
      await sock.sendMessage(msg.key.remoteJid, { video: fs.createReadStream(cachePath), caption: `❀ Título » ${title}\n> Calidad: 720p (caché)`, mimetype: 'video/mp4' }, { quoted: msg });
      return;
    }
    if (thumbnail) {
      try {
        const thumbBuffer = Buffer.from(await (await fetch(thumbnail)).arrayBuffer());
        await sock.sendMessage(msg.key.remoteJid, { image: thumbBuffer, caption: `「✦」Descargando *<${title}>*\n> ✐ Canal » *${uploader || 'Desconocido'}*\n> Calidad: 720p`, mimetype: 'image/jpeg' }, { quoted: msg });
      } catch {}
    }
    const tempDownload = path.join(TEMP_DIR, `raw_${Date.now()}.mp4`);
    const finalPath = await ytDlpDownloadToFile(urlToDownload, tempDownload);
    try {
      await sock.sendMessage(msg.key.remoteJid, { video: fs.createReadStream(finalPath), caption: `❀ Título » ${title}\n> Calidad: 720p original`, mimetype: 'video/mp4' }, { quoted: msg });
      fs.renameSync(finalPath, cachePath);
    } catch {
      const rebuiltPath = path.join(TEMP_DIR, `stable_${Date.now()}.mp4`);
      await new Promise((resolve, reject) => {
        const proc = spawn('ffmpeg', ['-i', finalPath, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', rebuiltPath], { stdio: 'pipe' });
        proc.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg error')));
        proc.on('error', reject);
      });
      await sock.sendMessage(msg.key.remoteJid, { video: fs.createReadStream(rebuiltPath), caption: `❀ Título » ${title}\n> Calidad: 720p (optimizado)`, mimetype: 'video/mp4' }, { quoted: msg });
      fs.renameSync(rebuiltPath, cachePath);
      fs.unlinkSync(finalPath);
    }
  } catch (e) { await sock.sendMessage(msg.key.remoteJid, { text: '● Error al descargar el video.' }, { quoted: msg }); }
}

async function handleYtAudio(sock, msg, query) {
  await sock.sendMessage(msg.key.remoteJid, { text: '⏳ Buscando audio...' }, { quoted: msg });
  try {
    const info = await ytDlpGetInfo(query);
    if (!info) throw new Error('No encontrado');
    const cacheKey = md5(info.webpage_url);
    const cachePath = path.join(AUDIO_CACHE, `${cacheKey}.mp3`);
    if (fs.existsSync(cachePath)) {
      const audioBuffer = fs.readFileSync(cachePath);
      const fileSize = audioBuffer.length;
      let durationStr = 'Desconocida';
      if (info.duration) {
        const mins = Math.floor(info.duration / 60), secs = info.duration % 60;
        durationStr = `${mins} minuto(s) ${secs} segundo(s)`;
      }
      const sizeMB = (fileSize / (1024 * 1024)).toFixed(2);
      let thumbBuffer = null;
      if (info.thumbnail) {
        try { thumbBuffer = Buffer.from(await (await fetch(info.thumbnail)).arrayBuffer()); } catch {}
      }
      const caption = `「✦」Descargando *<${info.title}>*\n\n` +
        `> ✐ Canal » *${info.uploader || 'Desconocido'}*\n` +
        `> ⴵ Duracion » *${durationStr}*\n` +
        `> ❒ Tamaño » *${sizeMB}MB*\n` +
        `> 🜸 Link » ${info.webpage_url}`;
      if (thumbBuffer) await sock.sendMessage(msg.key.remoteJid, { image: thumbBuffer, caption }, { quoted: msg });
      else await sock.sendMessage(msg.key.remoteJid, { text: caption }, { quoted: msg });
      await sock.sendMessage(msg.key.remoteJid, { audio: audioBuffer, mimetype: 'audio/mpeg', ptt: false, fileName: `${info.title}.mp3` }, { quoted: msg });
      return;
    }
    const tempPath = path.join(TEMP_DIR, `yta_${Date.now()}.mp3`);
    const finalPath = await ytDlpDownloadToFile(info.webpage_url, tempPath, { audio: true });
    const audioBuffer = fs.readFileSync(finalPath);
    const fileSize = audioBuffer.length;
    let durationStr = 'Desconocida';
    if (info.duration) {
      const mins = Math.floor(info.duration / 60), secs = info.duration % 60;
      durationStr = `${mins} minuto(s) ${secs} segundo(s)`;
    }
    const sizeMB = (fileSize / (1024 * 1024)).toFixed(2);
    let thumbBuffer = null;
    if (info.thumbnail) {
      try { thumbBuffer = Buffer.from(await (await fetch(info.thumbnail)).arrayBuffer()); } catch {}
    }
    const caption = `「✦」Descargando *<${info.title}>*\n\n` +
      `> ✐ Canal » *${info.uploader || 'Desconocido'}*\n` +
      `> ⴵ Duracion » *${durationStr}*\n` +
      `> ❒ Tamaño » *${sizeMB}MB*\n` +
      `> 🜸 Link » ${info.webpage_url}`;
    if (thumbBuffer) await sock.sendMessage(msg.key.remoteJid, { image: thumbBuffer, caption }, { quoted: msg });
    else await sock.sendMessage(msg.key.remoteJid, { text: caption }, { quoted: msg });
    await sock.sendMessage(msg.key.remoteJid, { audio: audioBuffer, mimetype: 'audio/mpeg', ptt: false, fileName: `${info.title}.mp3` }, { quoted: msg });
    fs.renameSync(finalPath, cachePath);
  } catch (e) { await sock.sendMessage(msg.key.remoteJid, { text: '● No se pudo descargar el audio.' }, { quoted: msg }); }
}

async function handleIg(sock, msg, url) {
  await sock.sendMessage(msg.key.remoteJid, { text: '⏳ Descargando Instagram...' }, { quoted: msg });
  try {
    if (!url.includes('instagram.com')) throw new Error('No es un enlace de Instagram');
    const temp = path.join(TEMP_DIR, `ig_${Date.now()}.mp4`);
    const final = await ytDlpDownloadToFile(url, temp);
    try {
      await sock.sendMessage(msg.key.remoteJid, { video: fs.createReadStream(final), caption: '📸 Video de Instagram (HD)', mimetype: 'video/mp4' }, { quoted: msg });
    } catch {
      const rebuilt = path.join(TEMP_DIR, `ig_rebuilt_${Date.now()}.mp4`);
      await new Promise((resolve, reject) => {
        const proc = spawn('ffmpeg', ['-i', final, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', rebuilt], { stdio: 'pipe' });
        proc.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg error')));
        proc.on('error', reject);
      });
      await sock.sendMessage(msg.key.remoteJid, { video: fs.createReadStream(rebuilt), caption: '📸 Video de Instagram (comprimido)', mimetype: 'video/mp4' }, { quoted: msg });
      fs.unlinkSync(rebuilt);
    }
    fs.unlinkSync(final);
  } catch (e) { await sock.sendMessage(msg.key.remoteJid, { text: '❌ No se pudo descargar el video de Instagram.' }, { quoted: msg }); }
}

// ━━━━━━━ NUEVO SISTEMA GACHA ━━━━━━━
const CLAIM_CD = 5 * 60 * 1000;  // 5 minutos
const VOTE_CD = 20 * 60 * 1000;  // 20 minutos

function formatTimeAgo(ts) {
  if (!ts || ts === 0) return 'nunca';
  const diff = Date.now() - ts;
  if (diff < 0) return 'ahora';
  const s = Math.floor(diff / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (s < 60) return `hace ${s}s`;
  if (m < 60) return `hace ${m}m ${s % 60}s`;
  if (h < 24) return `hace ${h}h ${m % 60}m ${s % 60}s`;
  return `hace ${d}d ${h % 24}h`;
}
function getRank(characters, cid) {
  const sorted = [...characters].sort((a, b) => b.value - a.value);
  return sorted.findIndex(c => c.id === cid) + 1;
}

async function handleRw(sock, msg, groupId, sender) {
  const cooldowns = getGroupCooldowns(groupId, sender);
  const BASE_CD = 300000;
  const economy = getGroupEconomy(groupId, sender);
  const reduction = economy.timeReduction || 0;
  const finalCD = Math.max(30000, BASE_CD - reduction);
  const now = Date.now();
  if (now - cooldowns.rw < finalCD) {
    const w = Math.ceil((finalCD - (now - cooldowns.rw)) / 1000);
    return sock.sendMessage(msg.key.remoteJid, { text: `⏳ Espera ${Math.floor(w/60)}m ${w%60}s para /rw` }, { quoted: msg });
  }

  await sock.sendMessage(msg.key.remoteJid, { text: 'Buscando personaje...' }, { quoted: msg });
  try {
    if (!charactersCache.length) { loadCharactersCache(); loadSeries(); }
    if (!charactersCache.length) return sock.sendMessage(msg.key.remoteJid, { text: '● No hay personajes en la base local.' }, { quoted: msg });

    const character = charactersCache[Math.floor(Math.random() * charactersCache.length)];
    const imagePath = getCharacterImage(character);
    if (!imagePath) return sock.sendMessage(msg.key.remoteJid, { text: '◇ Este personaje no tiene imágenes aún.' }, { quoted: msg });

    const claimEntry = character.claimedBy?.[groupId];
    const alreadyClaimed = claimEntry ? claimEntry.user : null;
    const estado = alreadyClaimed ? 'Reclamado' : 'Libre';
    const rank = getRank(charactersCache, character.id);

    cooldowns.rw = now;
    economy.lastClaim = {
      id: character.id,
      key: character.key,
      name: character.name,
      anime: character.anime,
      gender: character.gender,
      value: character.value,
      rarity: character.rarity,
      image: imagePath,
      claimed: !!alreadyClaimed,
      claimedBy: alreadyClaimed,
      timestamp: now,
      invoker: sender
    };
    saveDB();

    const cap = `❀ Nombre » *${character.name}*\n` +
      `⚥ Genero » *${character.gender}*\n` +
      `✰ Valor » *${character.value}*\n` +
      `♡ Estado » *${estado}*\n` +
      `❖ Fuente » *${character.anime}*\n` +
      `◈ Puesto » #${rank}\n` +
      `ⴵ Ultimo voto » *${formatTimeAgo(character.lastVote)}*\n\n` +
      `┃ Usa /c para reclamar`;

    let imageBuffer = imageCache.get(imagePath);
    if (!imageBuffer) { imageBuffer = fs.readFileSync(imagePath); imageCache.set(imagePath, imageBuffer); }
    await sock.sendMessage(msg.key.remoteJid, { image: imageBuffer, caption: cap, mimetype: 'image/jpeg' }, { quoted: msg });
  } catch (e) {
    console.error(e.stack);
    await sock.sendMessage(msg.key.remoteJid, { text: '● Error al buscar personaje.' }, { quoted: msg });
  }
}

async function handleResetGacha({ sock, jid, msg, sender }) {

  if (sender !== OWNER_NUMBER) {
    return sock.sendMessage(jid, {
      text: '◇ Solo el owner puede usar esto.'
    }, { quoted: msg });
  }

  const groups = db.groups || {};

  for (const groupId in groups) {

    groups[groupId].claimedCharacters = {};

    groups[groupId].harems = {};

    groups[groupId].training = {};

  }

  saveDB();

  await sock.sendMessage(jid, {
    text: '✦ Gacha reiniciado correctamente.\nTodos los personajes ahora están libres.'
  }, { quoted: msg });

for (const char of characterMap.values()) {
  delete char.claimedBy;
  delete char.owner;
}
}

async function handleClaim(sock, msg, groupId, sender) {
  const group = db.groups[groupId];
  const economy = getGroupEconomy(groupId, sender);
  const lc = economy.lastClaim;
  if (!lc) return sock.sendMessage(msg.key.remoteJid, { text: '◇ No hay personaje pendiente.' }, { quoted: msg });
  if (lc.claimed) return sock.sendMessage(msg.key.remoteJid, { text: '◇ Ya fue reclamado.' }, { quoted: msg });

  const cooldowns = getGroupCooldowns(groupId, sender);
  const now = Date.now();
  if (now - cooldowns.claim < CLAIM_CD) {
    const w = Math.ceil((CLAIM_CD - (now - cooldowns.claim)) / 1000);
    return sock.sendMessage(msg.key.remoteJid, { text: `⏳ Debes esperar ${Math.floor(w/60)}m ${w%60}s para reclamar de nuevo.` }, { quoted: msg });
  }

  const elapsed = now - lc.timestamp;
  if (elapsed < 20000 && sender !== lc.invoker) return sock.sendMessage(msg.key.remoteJid, { text: '◇ Solo el invocador puede reclamar en los primeros 20s.' }, { quoted: msg });
  if (elapsed > 30000) { economy.lastClaim = null; saveDB(); return sock.sendMessage(msg.key.remoteJid, { text: '◇ El tiempo expiró.' }, { quoted: msg }); }

  const character = characterKeyMap.get(lc.key);
  if (!character) return;
  if (!character.claimedBy) character.claimedBy = {};
  // Verificar que no esté ya reclamado en el grupo
  if (character.claimedBy[groupId] && character.claimedBy[groupId].user !== sender) {
    return sock.sendMessage(msg.key.remoteJid, { text: '◇ Este personaje ya fue reclamado por otro usuario.' }, { quoted: msg });
  }
  character.claimedBy[groupId] = { user: sender, time: now };
  if (!global.ownerIndex[groupId]) global.ownerIndex[groupId] = {};
  if (!global.ownerIndex[groupId][sender]) global.ownerIndex[groupId][sender] = new Set();
  global.ownerIndex[groupId][sender].add(lc.key);
  saveCharacters();

  if (!group.harems[sender]) group.harems[sender] = [];
  // Verificar que no esté duplicado en el harem
  if (!group.harems[sender].some(c => c.key === lc.key)) {
    group.harems[sender].push(lc);
  }
  cooldowns.claim = now;
  economy.lastClaim = null;
  saveDB();
  await sock.sendMessage(msg.key.remoteJid, { text: `✅ ¡${lc.name} reclamado por ${db.users[sender]?.name || 'Usuario'}!` }, { quoted: msg });
}

async function handleVote(sock, msg, args, groupId, sender) {
  const name = args.slice(1).join(' ').toLowerCase();
  if (!name) return sock.sendMessage(msg.key.remoteJid, { text: '◇ Uso: /vote [nombre]' }, { quoted: msg });
  if (!charactersCache.length) loadCharactersCache();
  const char = charactersCache.find(c => c.name.toLowerCase() === name);
  if (!char) return sock.sendMessage(msg.key.remoteJid, { text: '◇ Personaje no encontrado.' }, { quoted: msg });

  const now = Date.now();
  const globalCD = db.globalCooldowns.vote[sender] || 0;
  if (now - globalCD < VOTE_CD) {
    const rem = VOTE_CD - (now - globalCD);
    const mins = Math.floor(rem / 60000);
    const secs = Math.floor((rem % 60000) / 1000);
    return sock.sendMessage(msg.key.remoteJid, { text: `《✧》Ya votaste recientemente. Espera ${mins}m ${secs}s.` }, { quoted: msg });
  }

  char.value += 100;
  char.votes = (char.votes || 0) + 1;
  char.lastVote = now;
  db.globalCooldowns.vote[sender] = now;
  saveCharacters();
  saveDB();
  await sock.sendMessage(msg.key.remoteJid, { text: `✰ Valor de *${char.name}* aumentó a ${char.value}.` }, { quoted: msg });
}

// ━━━━━━━ COMANDOS DE SERIES ━━━━━━━
async function handleSlist(sock, msg, args) {
  const page = parseInt(args[1]) || 1;
  const perPage = 20;
  const allSeries = Array.from(seriesCache.values()).sort((a, b) => a.name.localeCompare(b.name));
  const pages = Math.ceil(allSeries.length / perPage);
  const slice = allSeries.slice((page-1)*perPage, page*perPage);
  if (!slice.length) return sock.sendMessage(msg.key.remoteJid, { text: '◇ No hay series disponibles.' }, { quoted: msg });
  let text = `❏ Lista de series (${allSeries.length}):\n\n`;
  for (const s of slice) text += `» ${s.name} (${s.characters.size})\n`;
  text += `\n«• Pagina ${page}/${pages}»`;
  await sock.sendMessage(msg.key.remoteJid, { text }, { quoted: msg });
}

async function handleAinfo(sock, msg, args, groupId) {
  const query = args.slice(1).join(' ').toLowerCase();
  if (!query) return sock.sendMessage(msg.key.remoteJid, { text: '◇ Uso: /ainfo <nombre de serie>' }, { quoted: msg });
  const series = seriesCache.get(query);
  if (!series) return sock.sendMessage(msg.key.remoteJid, { text: '◇ Serie no encontrada.' }, { quoted: msg });

  const chars = [];
  for (const key of series.characters) {
    const c = characterKeyMap.get(key);
    if (c) chars.push(c);
  }
  chars.sort((a, b) => b.value - a.value);
  const total = chars.length;
  const claimed = chars.filter(c => c.claimedBy?.[groupId]).length;
  const percent = ((claimed / total) * 100).toFixed(1);

  let text = `❀ Nombre: "<${series.name}>"\n\n` +
    `❏ Personajes » ${total}\n` +
    `♡ Reclamados » ${claimed}/${total} (${percent}%)\n\n` +
    `❏ Lista de personajes:\n\n`;
  for (const c of chars.slice(0, 20)) {
    const owner = c.claimedBy?.[groupId];
    const estado = owner ? `Reclamado por @${owner.user.split('@')[0]}` : 'Libre';
    text += `» ${c.name} (${c.value}) • ${estado}\n`;
  }
  if (chars.length > 20) text += `\n... y ${chars.length - 20} más.`;
  await sock.sendMessage(msg.key.remoteJid, { text, mentions: chars.filter(c => c.claimedBy?.[groupId]).map(c => c.claimedBy[groupId].user) }, { quoted: msg });
}

// ━━━━━━━ GINFO ACTUALIZADO ━━━━━━━
async function handleGinfo(sock, msg, groupId, sender) {
  const cooldowns = getGroupCooldowns(groupId, sender);
  const economy = getGroupEconomy(groupId, sender);
  const now = Date.now();

  const rwCD = Math.max(0, 300000 - (now - cooldowns.rw));
  const claimCD = Math.max(0, CLAIM_CD - (now - cooldowns.claim));
  const voteCD = Math.max(0, VOTE_CD - (now - (db.globalCooldowns.vote[sender] || 0)));

  const group = db.groups[groupId];
  const harem = group?.harems?.[sender] || [];
  const totalValue = harem.reduce((sum, c) => sum + c.value, 0);

  const text = `❀ Usuario "<${db.users[sender]?.name || 'Usuario'}>"\n\n` +
    `ⴵ RollWaifu » ${rwCD === 0 ? 'Ahora.' : `${Math.floor(rwCD/60000)}m ${Math.floor((rwCD%60000)/1000)}s`}\n` +
    `ⴵ Claim » ${claimCD === 0 ? 'Ahora.' : `${Math.floor(claimCD/60000)}m ${Math.floor((claimCD%60000)/1000)}s`}\n` +
    `ⴵ Vote » ${voteCD === 0 ? 'Ahora.' : `${Math.floor(voteCD/60000)}m ${Math.floor((voteCD%60000)/1000)}s`}\n\n` +
    `♡ Personajes reclamados » ${harem.length}\n` +
    `✰ Valor total » ${totalValue}\n` +
    `❏ Personajes totales » ${charactersCache.length}\n` +
    `❏ Series totales » ${seriesCache.size}`;
  await sock.sendMessage(msg.key.remoteJid, { text }, { quoted: msg });
}

// ━━━━━━━ TRADE NUEVO ━━━━━━━
const pendingTrades = new Map();

async function handleTrade(sock, msg, args, groupId, sender) {
  const input = args.slice(1).join(' ').trim();
  const parts = input.split('/').map(s => s.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return sock.sendMessage(msg.key.remoteJid, { text: '◇ Uso: /trade <personaje A> / <personaje B>' }, { quoted: msg });
  }
  const nameA = parts[0].toLowerCase();
  const nameB = parts[1].toLowerCase();

  const group = db.groups[groupId];
  if (!group || !group.harems) return;
  let charA, ownerA, charB, ownerB;
  for (const [uid, harem] of Object.entries(group.harems)) {
    if (!charA) {
      charA = harem.find(c => c.name.toLowerCase() === nameA);
      if (charA) ownerA = uid;
    }
    if (!charB) {
      charB = harem.find(c => c.name.toLowerCase() === nameB);
      if (charB) ownerB = uid;
    }
  }
  if (!charA || !charB) return sock.sendMessage(msg.key.remoteJid, { text: '◇ Uno o ambos personajes no están en el grupo.' }, { quoted: msg });
  if (ownerA === ownerB) return sock.sendMessage(msg.key.remoteJid, { text: '◇ Ambos personajes pertenecen al mismo usuario.' }, { quoted: msg });

  const tradeId = `${sender}_${Date.now()}`;
  pendingTrades.set(tradeId, { from: sender, to: (sender === ownerA) ? ownerB : ownerA, giveKey: charA.key, receiveKey: charB.key, groupId, timestamp: Date.now() });

  await sock.sendMessage(msg.key.remoteJid, {
    text: `❀ Solicitud de intercambio\n\n` +
      `@${sender.split('@')[0]} quiere intercambiar:\n\n` +
      `♡ ${charA.name}\n↕\n♡ ${charB.name}\n\n` +
      `@${((sender === ownerA) ? ownerB : ownerA).split('@')[0]} responde:\n` +
      `"aceptar" citando este mensaje`,
    mentions: [sender, (sender === ownerA) ? ownerB : ownerA]
  }, { quoted: msg });

  setTimeout(() => { pendingTrades.delete(tradeId); }, 120000);
}

async function checkTradeAccept(sock, msg, sender) {
  const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
  if (text.toLowerCase() !== 'aceptar') return false;
  const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  if (!quotedMsg) return false;
  for (const [id, trade] of pendingTrades) {
    if (trade.to === sender && Date.now() - trade.timestamp < 120000) {
      const group = db.groups[trade.groupId];
      if (!group || !group.harems) continue;
      const haremFrom = group.harems[trade.from] || [];
      const haremTo = group.harems[trade.to] || [];
      const charA = haremFrom.find(c => c.key === trade.giveKey);
      const charB = haremTo.find(c => c.key === trade.receiveKey);
      if (!charA || !charB) {
        await sock.sendMessage(msg.key.remoteJid, { text: '◇ Alguno de los personajes ya no está disponible.' }, { quoted: msg });
        pendingTrades.delete(id);
        return true;
      }
      haremFrom.splice(haremFrom.indexOf(charA), 1);
      haremTo.splice(haremTo.indexOf(charB), 1);
      haremFrom.push(charB);
      haremTo.push(charA);
      if (global.ownerIndex[trade.groupId]) {
        global.ownerIndex[trade.groupId][trade.from]?.delete(trade.giveKey);
        global.ownerIndex[trade.groupId][trade.to]?.delete(trade.receiveKey);
        if (!global.ownerIndex[trade.groupId][trade.from]) global.ownerIndex[trade.groupId][trade.from] = new Set();
        if (!global.ownerIndex[trade.groupId][trade.to]) global.ownerIndex[trade.groupId][trade.to] = new Set();
        global.ownerIndex[trade.groupId][trade.from].add(trade.receiveKey);
        global.ownerIndex[trade.groupId][trade.to].add(trade.giveKey);
      }
      const cA = characterKeyMap.get(trade.giveKey);
      const cB = characterKeyMap.get(trade.receiveKey);
      if (cA?.claimedBy?.[trade.groupId]?.user === trade.from) cA.claimedBy[trade.groupId].user = trade.to;
      if (cB?.claimedBy?.[trade.groupId]?.user === trade.to) cB.claimedBy[trade.groupId].user = trade.from;
      saveCharacters();
      saveDB();
      pendingTrades.delete(id);
      await sock.sendMessage(msg.key.remoteJid, { text: `✅ ¡Intercambio realizado! ${charA.name} ↔ ${charB.name}`, mentions: [trade.from, trade.to] }, { quoted: msg });
      return true;
    }
  }
  return false;
}

// ━━━━━━━ HAREM, DELWAIFU, WINFO, WTOP, WIMAGE, WAIFUVIDEO ━━━━━━━
async function handleHarem(sock, msg, groupId, sender, args, mentioned) {
  let target = mentioned.length ? mentioned[0] : sender;
  const harem = db.groups[groupId]?.harems?.[target] || [];
  if (!harem.length) return sock.sendMessage(msg.key.remoteJid, { text: '◇ Sin personajes reclamados.' }, { quoted: msg });
  const page = parseInt(args[1]) || 1;
  const perPage = 10;
  const sorted = [...harem].sort((a, b) => b.value - a.value);
  const total = sorted.length;
  const pages = Math.ceil(total / perPage);
  const slice = sorted.slice((page-1)*perPage, page*perPage);
  let text = `❀ Personajes reclamados ❀\n⌦ Usuario: *${db.users[target]?.name || 'Usuario'}*\n♡ Personajes: *(${total}):*\n\n`;
  slice.forEach(c => text += `» *${c.name}* (${c.value})\n`);
  text += `\n> ⌦ _Pagina *${page}* de *${pages}*_`;
  await sock.sendMessage(msg.key.remoteJid, { text }, { quoted: msg });
}

async function handleDelwaifu(sock, msg, args, groupId, sender) {
  const name = args.slice(1).join(' ').toLowerCase();
  if (!name) return sock.sendMessage(msg.key.remoteJid, { text: '◇ Uso: /delwaifu [nombre]' }, { quoted: msg });
  const harem = db.groups[groupId]?.harems?.[sender] || [];
  const idx = harem.findIndex(c => c.name.toLowerCase().includes(name));
  if (idx === -1) return sock.sendMessage(msg.key.remoteJid, { text: '◇ No tienes ese personaje.' }, { quoted: msg });
  const removed = harem.splice(idx, 1)[0];
  const char = characterKeyMap.get(removed.key);
  if (char?.claimedBy?.[groupId]?.user === sender) {
    delete char.claimedBy[groupId];
    if (global.ownerIndex[groupId]?.[sender]) global.ownerIndex[groupId][sender].delete(removed.key);
    saveCharacters();
  }
  saveDB();
  await sock.sendMessage(msg.key.remoteJid, { text: `✦ *${removed.name}* ha sido eliminado de tu lista.` }, { quoted: msg });
}

async function handleWinfo(sock, msg, query, groupId) {
  if (!query) return sock.sendMessage(msg.key.remoteJid, { text: '◇ Uso: /winfo [nombre]' }, { quoted: msg });
  await sock.sendMessage(msg.key.remoteJid, { text: 'Buscando personaje...' }, { quoted: msg });
  const q = query.toLowerCase().trim();
  const char = characterMap.get(q) || characterKeyMap.get(q);
  if (!char) return sock.sendMessage(msg.key.remoteJid, { text: '● Personaje no encontrado.' }, { quoted: msg });

  const imagePath = getCharacterImage(char);
  if (!imagePath) return sock.sendMessage(msg.key.remoteJid, { text: '◇ El personaje no tiene imágenes.' }, { quoted: msg });

  const owner = char.claimedBy?.[groupId]?.user || null;
  const estado = owner ? 'Reclamado' : 'Libre';
  const rank = getRank(charactersCache, char.id) || '?';

  const cap = `❀ Nombre » *${char.name}*\n` +
    `⚥ Genero » *${char.gender}*\n` +
    `✰ Valor » *${char.value  || 0}*\n` +
    `♡ Estado » *${estado}*\n` +
    `❖ Fuente » *${char.anime}*\n` +
    `◈ Puesto » #${rank}\n` +
    `ⴵ Ultimo voto » *${formatTimeAgo(char.lastVote)}*`;

  let buf = imageCache.get(imagePath) || (() => { const b = fs.readFileSync(imagePath); imageCache.set(imagePath, b); return b; })();
  await sock.sendMessage(msg.key.remoteJid, { image: buf, caption: cap, mimetype: 'image/jpeg' }, { quoted: msg });
}

async function handleWtop(sock, msg, args) {
  const page = parseInt(args[1]) || 1;
  const perPage = 10;
  const chars = [...charactersCache].sort((a, b) => b.value - a.value);
  if (!chars.length) return sock.sendMessage(msg.key.remoteJid, { text: '◇ No hay personajes.' }, { quoted: msg });
  const pages = Math.ceil(chars.length / perPage);
  const slice = chars.slice((page - 1) * perPage, page * perPage);
  let text = `❀ Personajes con mas valor:\n\n`;
  slice.forEach((c, i) => text += `✰ ${(page-1)*perPage + i + 1} » *${c.name}*\n        → Valor: *${c.value}*\n`);
  text += `\n> • Página *${page}* de *${pages}*`;
  const first = slice[0];
  if (first) {
    const imgPath = getCharacterImage(first);
    if (imgPath) {
      let buf = imageCache.get(imgPath) || (() => { const b = fs.readFileSync(imgPath); imageCache.set(imgPath, b); return b; })();
      await sock.sendMessage(msg.key.remoteJid, { image: buf, caption: text, mimetype: 'image/jpeg' }, { quoted: msg });
      return;
    }
  }
  await sock.sendMessage(msg.key.remoteJid, { text }, { quoted: msg });
}

async function handleWimage(sock, msg, query) {
  if (!query) return sock.sendMessage(msg.key.remoteJid, { text: '◇ Uso: /wimage [nombre]' }, { quoted: msg });
  const q = query.toLowerCase().trim();
  const char = characterMap.get(q);
  if (!char) return sock.sendMessage(msg.key.remoteJid, { text: '● Personaje no encontrado.' }, { quoted: msg });
  const imgPath = getCharacterImage(char);
  if (!imgPath) return sock.sendMessage(msg.key.remoteJid, { text: '◇ El personaje no tiene imágenes.' }, { quoted: msg });
  let buf = imageCache.get(imgPath) || (() => { const b = fs.readFileSync(imgPath); imageCache.set(imgPath, b); return b; })();
  const cap = `❀ ${char.name}\n❖ ${char.anime}\n✰ ${char.value}`;
  await sock.sendMessage(msg.key.remoteJid, { image: buf, caption: cap, mimetype: 'image/jpeg' }, { quoted: msg });
}

async function handleWaifuVideo({ sock, msg, args, jid }) {
  const query = args.slice(1).join(' ');

  if (!query) {
    return sock.sendMessage(jid, {
      text: '◇ Uso: /waifuvideo [nombre]'
    }, { quoted: msg });
  }

  const q = query.toLowerCase().trim();
  const char = characterMap.get(q);

  if (!char) {
    return sock.sendMessage(jid, {
      text: '● Personaje no encontrado.'
    }, { quoted: msg });
  }

  const key = char.key || char.name.toLowerCase().replace(/\s+/g, '_');
  const videoPath = getCharacterVideo(key);

  if (!videoPath) {
    return sock.sendMessage(jid, {
      text: '◇ El personaje no tiene videos aún.'
    }, { quoted: msg });
  }

  const cap =
    `❀ ${char.name}\n` +
    `❖ ${char.anime}\n` +
    `✰ ${char.value}`;

  await sock.sendMessage(jid, {
    video: fs.readFileSync(videoPath),
    caption: cap,
    mimetype: 'video/mp4'
  }, { quoted: msg });
}

async function handleWaifuEdit({ sock, msg, args, jid }) {

  const query = args.slice(1).join(' ').toLowerCase().trim();

  if (!query) {
    return sock.sendMessage(jid, {
      text: '◇ Uso: /waifuedit [nombre]'
    }, { quoted: msg });
  }

  if (!fs.existsSync(GACHA_VIDEOS)) {
    return sock.sendMessage(jid, {
      text: '◇ Carpeta de videos no encontrada.'
    }, { quoted: msg });
  }

  const videos = fs.readdirSync(GACHA_VIDEOS)
    .filter(v =>
      v.toLowerCase().startsWith(query) &&
      v.endsWith('.mp4')
    );

  if (!videos.length) {
    return sock.sendMessage(jid, {
      text: '◇ No se encontraron videos.'
    }, { quoted: msg });
  }

  const randomVideo =
    videos[Math.floor(Math.random() * videos.length)];

  const videoPath = path.join(GACHA_VIDEOS, randomVideo);

  await sock.sendMessage(jid, {
    video: fs.readFileSync(videoPath),
    caption: `✦ ${query}`,
    mimetype: 'video/mp4'
  }, { quoted: msg });
}

// ━━━━━━━ TOP GACHA, TOPGACHAGP, G
async function handleTop(sock, jid, msg, args = []) {

  let page = 1;

const textMsg =
  msg.message?.conversation ||
  msg.message?.extendedTextMessage?.text ||
  '';

const parts =
  textMsg.trim().split(' ');

if (parts[1]) {

  const parsed =
    parseInt(parts[1]);

  if (!isNaN(parsed) && parsed > 0) {
    page = parsed;
  }

}

  const usersPerPage = 10;

  const filteredUsers =
  Object.entries(db.users)
    .filter(([id, u]) => {

      return (
        (u.xp || 0) > 0
      );

    })

      .sort((a, b) =>
        (b[1].xp || 0) -
        (a[1].xp || 0)
      );

  const totalPages =
    Math.max(
      1,
      Math.ceil(
        filteredUsers.length /
        usersPerPage
      )
    );

  if (page > totalPages) {
    page = totalPages;
  }

  const start =
    (page - 1) *
    usersPerPage;

  const topUsers =
    filteredUsers.slice(
      start,
      start + usersPerPage
    );

  let text =
`◢✿ Top de usuarios con más experiencia ✿◤

`;

  topUsers.forEach((u, i) => {

    const user = u[1];

    text +=
`✰ ${start + i + 1} » *${user.name || 'Usuario'}*
\t\t❖ XP » *${user.xp || 0}*  ❖ LVL » *${user.level || 1}*

`;

  });

  text +=
`> • Página *${page}* de *${totalPages}*
> Para ver la siguiente página » */top ${page + 1}*`;

  await sock.sendMessage(
    jid,
    { text },
    { quoted: msg }
  );

}

async function handleLvl(sock, jid, msg, sender) {

  const user = initUser(
    sender,
    msg.pushName
  );

  const xp = user.xp || 0;
  const level = user.level || 1;

  const currentLevelXp =
    (level - 1) * 25000;

  const nextLevelXp =
    level * 25000;

  const progress =
    xp - currentLevelXp;

  const needed =
    nextLevelXp - currentLevelXp;

  const percent =
    Math.floor((progress / needed) * 100);

  const topUsers =
    Object.entries(db.users)
      .sort((a, b) =>
        (b[1].xp || 0) -
        (a[1].xp || 0)
      );

  const rank =
    topUsers.findIndex(
      ([id]) => id === sender
    ) + 1;

  const text =
`*「✿」Usuario* ◢ ${user.name} ◤

☆ Experiencia » *${xp}*
❖ Nivel » *${level}*
➨ Progreso » *${progress} => ${needed}*  _(${percent}%)_
# Puesto » *${rank}*

❒ Comandos totales » *${user.totalCommands || 0}*`;

  await sock.sendMessage(
    jid,
    { text },
    { quoted: msg }
  );

}

async function handleTopGachagp(sock, msg, args, groupId) {
  const group = db.groups[groupId];
  if (!group) return;
  const members = Object.entries(group.harems || {}).filter(([jid, h]) => h.length > 0)
    .sort((a, b) => b[1].length - a[1].length);
  const page = parseInt(args[1]) || 1;
  const perPage = 10;
  const pages = Math.ceil(members.length / perPage);
  const slice = members.slice((page-1)*perPage, page*perPage);
  if (!slice.length) return sock.sendMessage(msg.key.remoteJid, { text: '◇ No hay datos.' }, { quoted: msg });
  let text = `❀ Top Gacha del grupo\n\n`;
  slice.forEach(([jid, h], i) => {
    const sum = h.reduce((s, c) => s + (c.value || 0), 0);
    text += `✦ ${(page-1)*perPage + i + 1} » ${db.users[jid]?.name || 'Usuario'}\n    ✤ Personajes \`${h.length}\` ☆ Valor: \`${sum}\`\n`;
  });
  text += `\n✦ Página \`${page}/${pages}\``;
  await sock.sendMessage(msg.key.remoteJid, { text }, { quoted: msg });
}

async function handleGivechar(sock, msg, args, groupId, sender, mentioned) {
  if (!mentioned.length) return sock.sendMessage(msg.key.remoteJid, { text: '◇ Menciona a quién regalar.' }, { quoted: msg });
  const target = mentioned[0];
  const name = args.slice(1).filter(a => !a.startsWith('@')).join(' ').toLowerCase();
  if (!name) return sock.sendMessage(msg.key.remoteJid, { text: '◇ Uso: /givechar [nombre] @usuario' }, { quoted: msg });
  const myHarem = db.groups[groupId]?.harems?.[sender] || [];
  const idx = myHarem.findIndex(c => c.name.toLowerCase().includes(name));
  if (idx === -1) return sock.sendMessage(msg.key.remoteJid, { text: '◇ No tienes ese personaje.' }, { quoted: msg });
  const character = myHarem.splice(idx, 1)[0];
  if (!db.groups[groupId].harems[target]) db.groups[groupId].harems[target] = [];
  db.groups[groupId].harems[target].push(character);
  // Actualizar claimedBy y ownerIndex
  const char = characterKeyMap.get(character.key);
  if (char?.claimedBy?.[groupId]?.user === sender) {
    char.claimedBy[groupId].user = target;
    if (global.ownerIndex[groupId]?.[sender]) global.ownerIndex[groupId][sender].delete(character.key);
    if (!global.ownerIndex[groupId]) global.ownerIndex[groupId] = {};
    if (!global.ownerIndex[groupId][target]) global.ownerIndex[groupId][target] = new Set();
    global.ownerIndex[groupId][target].add(character.key);
    saveCharacters();
  }
  saveDB();
  await sock.sendMessage(msg.key.remoteJid, { text: `✰ *${character.name}* ha sido regalado a *${db.users[target]?.name || 'Usuario'}*!`, mentions: [target] }, { quoted: msg });
}

// ━━━━━━━ ECONOMÍA (POR GRUPO) ━━━━━━━
async function handleBal(sock, msg, groupId, sender, mentioned) {
  let target = mentioned.length ? mentioned[0] : sender;
  const eco = getGroupEconomy(groupId, target);
  const total = (eco.coins || 0) + (eco.bank || 0);
  const text = `✿ 》》Economía @${db.users[target]?.name || 'Usuario'}《《 ✿\n\n` +
    `⛀ Dinero » ¥${(eco.coins || 0)} ⋆.ೃ✧.\n` +
    `⚿ Banco » ¥${(eco.bank || 0)} ⋆.ೃ✧.\n` +
    `⛁ Total » ¥${total} ⋆.ೃ✧.\n\n` +
    `«Protege tu dinero con /deposit»`;
  await sock.sendMessage(msg.key.remoteJid, { text }, { quoted: msg });
}

async function handleDeposit(sock, msg, args, groupId, sender) {
  const amount = parseInt(args[1]);
  if (!amount || amount <= 0) return sock.sendMessage(msg.key.remoteJid, { text: '◇ Uso: /deposit <cantidad>' }, { quoted: msg });
  const eco = getGroupEconomy(groupId, sender);
  if (amount > (eco.coins || 0)) return sock.sendMessage(msg.key.remoteJid, { text: '◇ No tienes suficiente dinero en la wallet.' }, { quoted: msg });
  eco.coins -= amount;
  eco.bank = (eco.bank || 0) + amount;
  saveDB();
  await sock.sendMessage(msg.key.remoteJid, { text: `✦ Depositado ¥${amount} al banco.` }, { quoted: msg });
}

async function handleWithdraw(sock, msg, args, groupId, sender) {
  const amount = parseInt(args[1]);
  if (!amount || amount <= 0) return sock.sendMessage(msg.key.remoteJid, { text: '◇ Uso: /withdraw <cantidad>' }, { quoted: msg });
  const eco = getGroupEconomy(groupId, sender);
  if (amount > (eco.bank || 0)) return sock.sendMessage(msg.key.remoteJid, { text: '◇ No tienes suficiente dinero en el banco.' }, { quoted: msg });
  eco.bank -= amount;
  eco.coins = (eco.coins || 0) + amount;
  saveDB();
  await sock.sendMessage(msg.key.remoteJid, { text: `✦ Retirado ¥${amount.toLocaleString()} del banco.` }, { quoted: msg });
}

async function handleWork(sock, msg, groupId, sender) {
  const cooldowns = getGroupCooldowns(groupId, sender);
  const eco = getGroupEconomy(groupId, sender);
  const now = Date.now();
  if (now - cooldowns.work < 15000) {
    const w = Math.ceil((15000 - (now - cooldowns.work)) / 1000);
    return sock.sendMessage(msg.key.remoteJid, { text: `⏳ Espera ${w}s para trabajar.` }, { quoted: msg });
  }
  const earned = Math.floor(Math.random() * 10000) + 1000;
  eco.coins = (eco.coins || 0) + earned;
  cooldowns.work = now;
  saveDB();
  await sock.sendMessage(msg.key.remoteJid, { text: `✦ Ganaste ¥${earned.toLocaleString()} trabajando.` }, { quoted: msg });
}

async function handleSlut(sock, msg, groupId, sender) {
  const cooldowns = getGroupCooldowns(groupId, sender);
  const eco = getGroupEconomy(groupId, sender);
  const now = Date.now();
  if (now - cooldowns.slut < 240000) {
    const w = Math.ceil((240000 - (now - cooldowns.slut)) / 1000);
    return sock.sendMessage(msg.key.remoteJid, { text: `⏳ Espera ${Math.floor(w/60)}m ${w%60}s para /slut` }, { quoted: msg });
  }
  const earned = Math.floor(Math.random() * 5000) + 10000;
  eco.coins = (eco.coins || 0) + earned;
  cooldowns.slut = now;
  saveDB();
  await sock.sendMessage(msg.key.remoteJid, { text: `✦ Ganaste ¥${earned.toLocaleString()} con /slut.` }, { quoted: msg });
}

async function handleCrime(sock, msg, groupId, sender) {
  const cooldowns = getGroupCooldowns(groupId, sender);
  const eco = getGroupEconomy(groupId, sender);
  const now = Date.now();
  if (now - cooldowns.crime < 300000) {
    const w = Math.ceil((300000 - (now - cooldowns.crime)) / 1000);
    return sock.sendMessage(msg.key.remoteJid, { text: `⏳ Espera ${Math.floor(w/60)}m ${w%60}s para /crime` }, { quoted: msg });
  }
  const earned = Math.floor(Math.random() * 50000) + 50000;
  eco.coins = (eco.coins || 0) + earned;
  cooldowns.crime = now;
  saveDB();
  await sock.sendMessage(msg.key.remoteJid, { text: `✦ Robaste ¥${earned.toLocaleString()} exitosamente.` }, { quoted: msg });
}

async function handleDaily(sock, msg, groupId, sender) {
  const cooldowns = getGroupCooldowns(groupId, sender);
  const eco = getGroupEconomy(groupId, sender);
  const now = Date.now();
  if (now - cooldowns.daily < 86400000) {
    const w = Math.ceil((86400000 - (now - cooldowns.daily)) / 1000);
    const h = Math.floor(w/3600), m = Math.floor((w%3600)/60), s = w%60;
    return sock.sendMessage(msg.key.remoteJid, { text: `⏳ Espera ${h}h ${m}m ${s}s para tu daily.` }, { quoted: msg });
  }
  const earned = 50000 + Math.floor(Math.random() * 50000);
  eco.coins = (eco.coins || 0) + earned;
  cooldowns.daily = now;
  saveDB();
  await sock.sendMessage(msg.key.remoteJid, { text: `✦ Reclamaste tu daily de ¥${earned.toLocaleString()}.` }, { quoted: msg });
}

async function handleSell(sock, msg, args, groupId, sender) {
  const name = args.slice(1).join(' ').toLowerCase();
  if (!name) return sock.sendMessage(msg.key.remoteJid, { text: '◇ Uso: /sell [nombre]' }, { quoted: msg });
  const harem = db.groups[groupId]?.harems?.[sender] || [];
  const idx = harem.findIndex(c => c.name.toLowerCase().includes(name));
  if (idx === -1) return sock.sendMessage(msg.key.remoteJid, { text: '◇ No tienes ese personaje.' }, { quoted: msg });
  const character = harem.splice(idx, 1)[0];
  const eco = getGroupEconomy(groupId, sender);
  const sellValue = Math.floor(character.value * 1.5);
  eco.coins = (eco.coins || 0) + sellValue;
  const char = characterKeyMap.get(character.key);
  if (char?.claimedBy?.[groupId]?.user === sender) {
    delete char.claimedBy[groupId];
    if (global.ownerIndex[groupId]?.[sender]) global.ownerIndex[groupId][sender].delete(character.key);
    saveCharacters();
  }
  saveDB();
  await sock.sendMessage(msg.key.remoteJid, { text: `✦ Vendiste *${character.name}* por ¥${sellValue.toLocaleString()}` }, { quoted: msg });
}

async function handleTime(sock, msg, args, groupId, sender) {
  const reduction = parseInt(args[1]);
  if (!reduction || reduction <= 0) return sock.sendMessage(msg.key.remoteJid, { text: '◇ Uso: /time <segundos>' }, { quoted: msg });
  if (reduction > 180) return sock.sendMessage(msg.key.remoteJid, { text: '◇ Máximo 180 segundos.' }, { quoted: msg });
  const eco = getGroupEconomy(groupId, sender);
  const cost = reduction * 1000000;
  if ((eco.coins || 0) < cost) return sock.sendMessage(msg.key.remoteJid, { text: `◇ Necesitas ¥${cost.toLocaleString()} para reducir ${reduction}s.` }, { quoted: msg });
  eco.coins -= cost;
  eco.timeReduction = (eco.timeReduction || 0) + reduction * 1000;
  saveDB();
  await sock.sendMessage(msg.key.remoteJid, { text: `✦ Redujiste el cooldown de /rw en ${reduction}s por ¥${cost.toLocaleString()}.` }, { quoted: msg });
}

async function handleCf(sock, msg, args, groupId, sender) {
  const side = args[1]?.toLowerCase();
  const amount = parseInt(args[2]);
  if (!side || !amount || amount <= 0 || (side !== 'cara' && side !== 'sello')) {
    return sock.sendMessage(msg.key.remoteJid, { text: '◇ Uso: /cf cara|cantidad' }, { quoted: msg });
  }
  const eco = getGroupEconomy(groupId, sender);
  if ((eco.coins || 0) < amount) return sock.sendMessage(msg.key.remoteJid, { text: '◇ No tienes suficiente dinero.' }, { quoted: msg });
  eco.coins -= amount;
  const result = Math.random() < 0.5 ? 'cara' : 'sello';
  if (side === result) {
    eco.coins += amount * 2;
    saveDB();
    await sock.sendMessage(msg.key.remoteJid, { text: `¡Ganaste! Salió *${result}*. +¥${(amount*2).toLocaleString()}` }, { quoted: msg });
  } else {
    saveDB();
    await sock.sendMessage(msg.key.remoteJid, { text: `Perdiste. Salió *${result}*. -¥${amount.toLocaleString()}` }, { quoted: msg });
  }
}

// ━━━━━━━ TOP / BALTOP / BALTOPGP ━━━━━━━
async function handleBaltop(sock, msg, args) {
  const page = parseInt(args[1]) || 1;
  const perPage = 10;
  const all = Object.entries(db.users).filter(([, u]) => u.totalCommands > 0)
    .sort((a, b) => ((b[1].coins || 0) + (b[1].bank || 0)) - ((a[1].coins || 0) + (a[1].bank || 0)));
  const pages = Math.ceil(all.length / perPage);
  const slice = all.slice((page-1)*perPage, page*perPage);
  if (!slice.length) return sock.sendMessage(msg.key.remoteJid, { text: '◇ Página vacía.' }, { quoted: msg });
  let text = `『✦』Top Usuarios con más Coins (global)\n\n`;
  slice.forEach(([id, u], i) => {
    const total = (u.coins || 0) + (u.bank || 0);
    text += `✦ ${(page-1)*perPage + i + 1} » ${u.name}\n    ✤ Coins \`${total.toLocaleString()}\`\n`;
  });
  text += `\n✦ Página \`${page}/${pages}\``;
  await sock.sendMessage(msg.key.remoteJid, { text }, { quoted: msg });
}

async function handleBaltopgp(sock, msg, args) {
  const groupId = msg.key.remoteJid;
  const group = db.groups[groupId];
  if (!group) return;
  const members = Object.keys(group.members || {}).filter(jid => db.users[jid]);
  const ranked = members.map(jid => ({ jid, user: db.users[jid] }))
    .sort((a, b) => {
      const totalA = (a.user.coins || 0) + (a.user.bank || 0);
      const totalB = (b.user.coins || 0) + (b.user.bank || 0);
      return totalB - totalA;
    });
  const page = parseInt(args[1]) || 1;
  const perPage = 10;
  const pages = Math.ceil(ranked.length / perPage);
  const slice = ranked.slice((page-1)*perPage, page*perPage);
  if (!slice.length) return sock.sendMessage(msg.key.remoteJid, { text: '◇ No hay datos.' }, { quoted: msg });
  let text = `『✦』Top Coins del grupo\n\n`;
  slice.forEach((entry, i) => {
    const total = (entry.user.coins || 0) + (entry.user.bank || 0);
    text += `✦ ${(page-1)*perPage + i + 1} » ${entry.user.name}\n    ✤ Coins \`${total.toLocaleString()}\`\n`;
  });
  text += `\n✦ Página \`${page}/${pages}\``;
  await sock.sendMessage(msg.key.remoteJid, { text }, { quoted: msg });
}

// ━━━━━━━ STATUS / BOTS / CODE ━━━━━━━
async function handleStatus(sock, msg) {
  const used = process.memoryUsage().rss / 1024 / 1024;
  const cpu = os.cpus().length;
  const users = Object.keys(db.users).length;
  const groups = Object.keys(db.groups).length;
  const totalCmds = db.stats.totalCommands || 0;
  const txt = `「✦」Estado de Mavis's study\n\n` +
    `❒ Ram [MAIN]: ${used.toFixed(1)} MB\n` +
    `❒ CPU (x${cpu}): ${cpu} núcleos\n` +
    `✐ Comandos ejecutados: ${totalCmds}\n` +
    `❒ Usuarios registrados: ${users}\n` +
    `❒ Grupos registrados: ${groups}\n\n` +
    `◤ Hosts:\n✦ [principales x1] » 1 sesión`;
  await sock.sendMessage(msg.key.remoteJid, { text: txt }, { quoted: msg });
}

async function handleBots(sock, msg) {
  // Sin sistema de sub‑bots activo, solo se muestra el principal
  let txt = `「✦」Lista de bots activos\n\n` +
    `❖ Principales » 1\n` +
    `✰ Premiums » 0\n` +
    `✿ Subs » 0\n` +
    `ⴵ Temporales » 0\n\n` +
    `❏ En este grupo:\n` +
    `• Bot principal activo.`;
  await sock.sendMessage(msg.key.remoteJid, { text: txt }, { quoted: msg });
}

// ━━━━━━━ SUB‑BOT /code (SIN SERVIDOR HTTP) ━━━━━━━
async function handleCode(sock, msg, sender) {
  // Sistema de código simplificado sin servidor HTTP
  const rawUser = msg.key.participant || msg.participant || sender;
  const phone = rawUser.split('@')[0];
  try {
    // Generar código directamente con Baileys
    const folder = path.join('./subbots', `sub_${phone}_${Date.now()}`);
    const { state } = await useMultiFileAuthState(folder);
    const subSock = makeWASocket({
      auth: state,
      logger: P({ level: 'silent' }),
      printQRInTerminal: false
    });
    
    const code = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        subSock.logout().catch(() => {});
        try { fs.rmSync(folder, { recursive: true, force: true }); } catch {}
        reject(new Error('Tiempo agotado'));
      }, 60000);
      
      subSock.requestPairingCode(phone)
        .then(code => {
          clearTimeout(timeout);
          subSock.logout().catch(() => {});
          resolve(code);
        })
        .catch(err => {
          clearTimeout(timeout);
          reject(err);
        });
    });
    
    await sock.sendMessage(msg.key.remoteJid, { 
      text: `✿ Vincula tu cuenta usando el código.\n` +
        `Sigue las instrucciones:\n` +
        `✎ Mas opciones » Dispositivos vinculados » Vincular nuevo dispositivo » Vincular usando número.\n` +
        `_Recuerda que es recomendable no usar tu cuenta principal para registrar bots._\n` +
        `↺ El código es válido por 60 segundos.`
    }, { quoted: msg });
    await sock.sendMessage(msg.key.remoteJid, { text: code }, { quoted: msg });
    
    // Limpiar después de 60 segundos
    setTimeout(() => {
      try { fs.rmSync(folder, { recursive: true, force: true }); } catch {}
    }, 60000);
    
  } catch (e) {
    await sock.sendMessage(msg.key.remoteJid, { text: '《✧》 No se pudo generar el código de vinculación.' }, { quoted: msg });
  }
}

// ━━━━━━━ MODERACIÓN ━━━━━━━
async function handleMute(sock, msg, mentioned, groupData) {
  if (!mentioned.length) return sock.sendMessage(msg.key.remoteJid, { text: '◇ Menciona a un usuario.' }, { quoted: msg, mentions: [] });
  const target = mentioned[0];
  if (target === OWNER_NUMBER) return sock.sendMessage(msg.key.remoteJid, { text: '◇ No puedes silenciar al owner del bot.' }, { quoted: msg });
  if (!groupData.muted.includes(target)) { groupData.muted.push(target); saveDB(); }
  await sock.sendMessage(msg.key.remoteJid, { text: `🔇 @${target.split('@')[0]} ha sido silenciado.`, mentions: [target] }, { quoted: msg });
}

async function handleUnmute(sock, msg, mentioned, groupData) {
  if (!mentioned.length) return sock.sendMessage(msg.key.remoteJid, { text: '◇ Menciona a un usuario.' }, { quoted: msg, mentions: [] });
  const target = mentioned[0];
  groupData.muted = groupData.muted.filter(jid => jid !== target); saveDB();
  await sock.sendMessage(msg.key.remoteJid, { text: `🔊 @${target.split('@')[0]} puede hablar nuevamente.`, mentions: [target] }, { quoted: msg });
}

async function handleAntilink(sock, msg, args, groupData) {
  const opt = args[1]?.toLowerCase();
  if (opt === 'on') { groupData.antilink = true; saveDB(); await sock.sendMessage(msg.key.remoteJid, { text: '✅ Antilink activado.' }, { quoted: msg }); }
  else if (opt === 'off') { groupData.antilink = false; saveDB(); await sock.sendMessage(msg.key.remoteJid, { text: '❌ Antilink desactivado.' }, { quoted: msg }); }
  else await sock.sendMessage(msg.key.remoteJid, { text: `◇ Uso: /antilink on/off (actual: ${groupData.antilink ? 'on' : 'off'})` }, { quoted: msg });
}

async function checkModeration(sock, msg, groupData, sender) {
  if (!groupData) return false;
  if (groupData.muted.includes(sender)) {
    try { await sock.sendMessage(msg.key.remoteJid, { delete: msg.key }); } catch {}
    return true;
  }
  if (groupData.antilink) {
    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
    if (/https?:\/\/[^\s]+/.test(text)) {
      try {
        const meta = await sock.groupMetadata(msg.key.remoteJid);
        const admins = meta.participants.filter(p => p.admin).map(p => p.id);
        if (!admins.includes(sender) && sender !== OWNER_NUMBER) {
          await sock.sendMessage(msg.key.remoteJid, { delete: msg.key });
          await sock.sendMessage(msg.key.remoteJid, { text: `⚠️ @${sender.split('@')[0]} eliminado por enlaces.`, mentions: [sender] });
          await sock.groupParticipantsUpdate(msg.key.remoteJid, [sender], 'remove');
          return true;
        }
      } catch {}
    }
  }
  return false;
}

// ━━━━━━━ HELP / BANNER / PREFIX / INFO ━━━━━━━
async function handleHelp(sock, msg, usedPrefix) {
  let bannerBuffer = null;
  if (db.banners['global'] && fs.existsSync(db.banners['global'])) {
    bannerBuffer = imageCache.get(db.banners['global']) || fs.readFileSync(db.banners['global']);
  } else if (fs.existsSync(GACHA_IMAGES)) {
    const files = fs.readdirSync(GACHA_IMAGES);
    if (files.length) {
      const p = path.join(GACHA_IMAGES, files[Math.floor(Math.random() * files.length)]);
      bannerBuffer = imageCache.get(p) || fs.readFileSync(p);
    }
  }
  const text = `𝐇𝐨𝐥𝐚! 𝐒𝐨𝐲 *Principal-Bot*
ᴀǫᴜɪ ᴛɪᴇɴᴇs ʟᴀ ʟɪsᴛᴀ ᴅᴇ ᴄᴏᴍᴀɴᴅᴏs

» ˚୨•(=^●ω●^=)• ⊹ \`Gacha\` ⊹

❀ \`/rw\` - Invocar personaje
❀ \`/c\` - Reclamar personaje
❀ \`/harem\` - Ver colección
❀ \`/topgachagp\` - Top gacha del grupo
❀ \`/wtop\` - Top personajes
❀ \`/vote\` - Votar personaje
❀ \`/delwaifu\` - Eliminar personaje
❀ \`/winfo [nombre]\` - Información
❀ \`/wimage [nombre]\` - Imagen
❀ \`/waifuvideo [nombre]\` - Video
❀ \`/givechar\` - Regalar personaje
❀ \`/trade\` - Intercambiar personaje
❀ \`/slist\` - Lista de series
❀ \`/ainfo <serie>\` - Información de serie
❀ \`/ginfo\` - Información gacha

» ˚୨•(=^●ω●^=)• ⊹ \`Economía\` ⊹

❀ \`/bal\`
❀ \`/deposit\`
❀ \`/withdraw\`
❀ \`/w\`
❀ \`/slut\`
❀ \`/crime\`
❀ \`/daily\`
❀ \`/sell\`
❀ \`/cf cara|cantidad\`
❀ \`/time <seg>\`
❀ \`/top\` - Ranking experiencia
❀ \`/baltop\` - Ranking coins
❀ \`/baltopgp\` - Ranking grupo
❀ \`/lvl\` - Ver nivel y experiencia

» ˚୨•(=^●ω●^=)• ⊹ \`Descargas\` ⊹

❀ \`/mp4\`
❀ \`/ytaudio\`
❀ \`/tt\`
❀ \`/ig\`

» ˚୨•(=^●ω●^=)• ⊹ \`Moderación\` ⊹

❀ \`/mute\`
❀ \`/unmute\`
❀ \`/antilink\`
❀ \`/bot off\`
❀ \`/bot on\`
❀ \`/offgl\`

» ˚୨•(=^●ω●^=)• ⊹ \`Owner\` ⊹

❀ \`/setbanner\`
❀ \`/resetgacha\`
❀ \`/cleanimg\`

» ˚୨•(=^●ω●^=)• ⊹ \`Utilidades\` ⊹

❀ \`/code\` - Crear sub-bot
❀ \`/setbotprefix\`
❀ \`/infousuario\`
❀ \`/gp\`
❀ \`/pfp\`
❀ \`/p\`

`;

  if (bannerBuffer) {
  await sock.sendMessage(
    msg.key.remoteJid,
    {
      image: bannerBuffer,
      caption: text,
      mimetype: 'image/jpeg'
    },
    { quoted: msg }
  );
} else {
  await sock.sendMessage(
    msg.key.remoteJid,
    { text },
    { quoted: msg }
  );
}
}

async function handleSetBanner(sock, msg) {
  const qm = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  if (!qm?.imageMessage) return sock.sendMessage(msg.key.remoteJid, { text: '◇ Cita una imagen.' }, { quoted: msg });
  try {
    const buffer = await downloadMediaMessage({ key: { ...msg.key, id: msg.message.extendedTextMessage.contextInfo.stanzaId }, message: qm }, 'buffer', {});
    const bannerPath = path.join(GACHA_PATH, 'banner.jpg');
    fs.writeFileSync(bannerPath, buffer);
    db.banners['global'] = bannerPath;
    imageCache.set(bannerPath, buffer);
    saveDB();
    await sock.sendMessage(msg.key.remoteJid, { text: '✅ Banner actualizado.' }, { quoted: msg });
  } catch { await sock.sendMessage(msg.key.remoteJid, { text: '❌ Error.' }, { quoted: msg }); }
}

async function handleSetPrefix(sock, msg, args) {
  const p = args[1];
  if (!p || p.length !== 1) return sock.sendMessage(msg.key.remoteJid, { text: '◇ Uso: /setbotprefix <carácter>' }, { quoted: msg });
  db.prefix = p; saveDB();
  await sock.sendMessage(msg.key.remoteJid, { text: `◇ Prefijo cambiado a *${p}*` }, { quoted: msg });
}

async function handleInfousuario(sock, msg, mentioned, quotedUser, groupId) {
  const target = mentioned.length ? mentioned[0] : quotedUser;
  if (!target) return sock.sendMessage(msg.key.remoteJid, { text: '◇ Menciona o cita a un usuario.' }, { quoted: msg });
  const u = db.users[target];
  const g = db.groups[groupId];
  const stats = g?.members?.[target] || {};
  const txt = `╭〔 Stats 〕╮\n` +
    `│▪︎ Usuario: @${target.split('@')[0]}\n` +
    `│▪︎ Mensajes: \`${stats.messages || 0}\`\n` +
    `│▪︎ Msg/seg: \`${((stats.messages || 0) / Math.max(1, (Date.now() - (stats.firstMessage || Date.now())) / 1000)).toFixed(2)}\`\n` +
    `│▪︎ Menciones: \`${stats.mentions || 0}\`\n` +
    `│▪︎ Comandos: \`${u?.totalCommands || 0}\`\n` +
    `╰〔● Datos ●〕╯`;
  await sock.sendMessage(msg.key.remoteJid, { text: txt, mentions: [target] }, { quoted: msg });
}

async function handleGp(sock, msg, groupId) {
  const meta = await sock.groupMetadata(groupId);
  const txt = `Grupo > ${meta.subject}\n` +
    `Mensajes: ${db.groups[groupId]?.totalMessages || 0}\n` +
    `Usuarios: ${meta.participants.length}\n` +
    `Owner: ${meta.owner?.split('@')[0] || 'Desconocido'}\n` +
    `Admins: ${meta.participants.filter(p => p.admin).length}`;
  await sock.sendMessage(msg.key.remoteJid, { text: txt }, { quoted: msg });
}

async function handlePfp(sock, msg, mentioned) {
  if (!mentioned.length) return sock.sendMessage(msg.key.remoteJid, { text: '◇ Menciona a un usuario.' }, { quoted: msg });
  const target = mentioned[0];
  try {
    const url = await sock.profilePictureUrl(target, 'image').catch(() => null);
    if (!url) return sock.sendMessage(msg.key.remoteJid, { text: '◇ Sin foto.' }, { quoted: msg });
    const buffer = Buffer.from(await (await fetch(url)).arrayBuffer());
    await sock.sendMessage(msg.key.remoteJid, { image: buffer, caption: `Foto de @${target.split('@')[0]}`, mentions: [target] }, { quoted: msg });
  } catch { await sock.sendMessage(msg.key.remoteJid, { text: '❌ Error.' }, { quoted: msg }); }
}

async function handleCleanImg(sock, msg, key) {
  if (!key) return sock.sendMessage(msg.key.remoteJid, { text: '◇ Uso: /cleanimg [key]' }, { quoted: msg });
  if (!fs.existsSync(IMPORT_PATH)) fs.mkdirSync(IMPORT_PATH);
  const validExts = ['.jpg', '.jpeg', '.png', '.webp'];
  const files = fs.readdirSync(IMPORT_PATH).filter(f => validExts.includes(path.extname(f).toLowerCase()));
  if (!files.length) return sock.sendMessage(msg.key.remoteJid, { text: '◇ No hay imágenes en import.' }, { quoted: msg });
  let converted = 0, renamed = 0, deleted = 0;
  const existing = getCharacterImages(key);
  let lastNum = 0;
  for (const img of existing) {
    const match = img.match(new RegExp(`^${key}_(\\d+)\\.jpg$`));
    if (match) lastNum = Math.max(lastNum, parseInt(match[1]));
  }
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    const input = path.join(IMPORT_PATH, file);
    try {
      if (fs.statSync(input).size < 15 * 1024) { fs.unlinkSync(input); deleted++; continue; }
      lastNum++;
      const output = path.join(GACHA_IMAGES, `${key}_${lastNum}.jpg`);
      if (ext === '.jpg' || ext === '.jpeg') {
        fs.renameSync(input, output);
      } else {
        await new Promise((resolve, reject) => {
          const proc = spawn('ffmpeg', ['-i', input, '-q:v', '2', output], { stdio: 'pipe' });
          proc.on('close', code => code === 0 ? (fs.unlinkSync(input), resolve()) : reject());
          proc.on('error', reject);
        });
        converted++;
      }
      renamed++;
    } catch { try { fs.unlinkSync(input); } catch {}; deleted++; }
  }
  await sock.sendMessage(msg.key.remoteJid, { text: `✅ Imágenes procesadas\n\n✦ Personaje: ${key}\n✦ Convertidas: ${converted}\n✦ Renombradas: ${renamed}\n✦ Eliminadas: ${deleted}\n✦ Guardadas en: /gacha/images` }, { quoted: msg });
}

// ━━━━━━━ INICIO DEL BOT ━━━━━━━
global.startupTime = Date.now();

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    auth: state,
    version,
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '120.0.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 10000
});

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async (update) => {
    const { connection } = update;

    if (connection === 'connecting') {
        console.log('Conectando...');
    }

    if (connection === 'open') {
        console.log('¡Conectado con éxito!');
    }

    if (connection === 'close') {
        console.log('Conexión cerrada');
    }
});

if (!sock.authState?.creds?.registered) {
    setTimeout(async () => {
        try {
            const code = await sock.requestPairingCode('51974926627');
            console.log('Código:', code);
        } catch (e) {
            console.error('Error al pedir código:', e);
        }
    }, 5000);
}
});

// SOLICITAR EL CÓDIGO FUERA DEL EVENTO O BIEN CONTROLADO
// Justo después de definir sock.ev.on('creds.update', saveCreds);
if (!sock.authState.creds.registered) {
    setTimeout(async () => {
        try {
            // Asegúrate de que no se esté pidiendo en bucle
            let code = await sock.requestPairingCode('51974926627');
            console.log('Tu código de vinculación es:', code);
        } catch (e) {
            console.error('Error al pedir código:', e);
        }
    }, 5000); // Un pequeño delay para dejar que inicialice
}
});

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;
    // Ignorar mensajes antiguos (anteriores al inicio del bot)
    if (msg.messageTimestamp && msg.messageTimestamp < Math.floor(global.startupTime / 1000)) return;

    const jid = msg.key.remoteJid;
    if (!jid || !jid.endsWith('@g.us')) return;
    const sender = msg.key.participant || jid;
    console.log('SENDER:', sender);

    const user = initUser(sender, msg.pushName);

    user.messages += 1;
    user.xp += 100;

    const newLevel =
      Math.floor(user.xp / 25000) + 1;

    if (newLevel > user.level) {

      user.level = newLevel;

      await sock.sendMessage(jid, {
        text: `✦ @${sender.split('@')[0]} subió al nivel ${user.level}!`,
        mentions: [sender]
      });

    }

    const groupData = initGroup(jid);

    if (groupData.off && sender !== OWNER_NUMBER)
      return;

    groupData.totalMessages =
      (groupData.totalMessages || 0) + 1;

    if (!groupData.members[sender]) {

      groupData.members[sender] = {
        messages: 0,
        mentions: 0,
        firstMessage: Date.now()
      };

    }

    groupData.members[sender].messages++;

    const mentioned =
      msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];

    for (const m of mentioned) {

      if (!groupData.members[m]) {

        groupData.members[m] = {
          messages: 0,
          mentions: 0,
          firstMessage: Date.now()
        };

      }

      groupData.members[m].mentions =
        (groupData.members[m].mentions || 0) + 1;

    }

    if (await checkModeration(sock, msg, groupData, sender))
      return;

    if (await checkTradeAccept(sock, msg, sender))
      return;

const text =
  msg.message.conversation ||
  msg.message.extendedTextMessage?.text;

if (!text) return;

const args = text.trim().split(' ');

const cmd = args[0].toLowerCase();

const ctx = msg.message.extendedTextMessage?.contextInfo;

const quotedJid = ctx?.participant;

const usedPrefix = db.prefix || '/';

if (!cmd.startsWith(usedPrefix)) return;

const command = cmd.slice(usedPrefix.length);

if (
  db.botOff &&
  !(command === 'bot' && args[0] === 'on')
) return;

user.totalCommands =
  (user.totalCommands || 0) + 1;

if (!user.favCommands)
  user.favCommands = {};

user.favCommands[command] =
  (user.favCommands[command] || 0) + 1;

db.stats.totalCommands =
  (db.stats.totalCommands || 0) + 1;

switch (command) {
      case 'tomp3': await handleTomp3(sock, msg); break;
      case 'tt': { const url = args[1]; if (!url?.includes('tiktok.com')) return sock.sendMessage(jid, { text: `◇ Uso: ${usedPrefix}tt [link]` }); await handleTt(sock, msg, url); break; }
      case 'mp4': { const input = args.slice(1).join(' '); if (!input) return sock.sendMessage(jid, { text: `◇ Uso: ${usedPrefix}mp4 [enlace/nombre]` }); await handleMp4(sock, msg, input); break; }
      case 'ytaudio': { const query = args.slice(1).join(' '); if (!query) return sock.sendMessage(jid, { text: `◇ Uso: ${usedPrefix}ytaudio [nombre]` }); await handleYtAudio(sock, msg, query); break; }
      case 'ig': { const url = args[1]; if (!url?.includes('instagram.com')) return sock.sendMessage(jid, { text: `◇ Uso: ${usedPrefix}ig [link]` }); await handleIg(sock, msg, url); break; }
      case 'rw': await handleRw(sock, msg, jid, sender); break;
      case 'c': await handleClaim(sock, msg, jid, sender); break;
      case 'winfo': { const query = args.slice(1).join(' '); if (!query) return sock.sendMessage(jid, { text: `◇ Uso: ${usedPrefix}winfo [nombre]` }); await handleWinfo(sock, msg, query, jid); break; }
      case 'wtop': await handleWtop(sock, msg, args); break;
      case 'wimage': { const query = args.slice(1).join(' '); if (!query) return sock.sendMessage(jid, { text: `◇ Uso: ${usedPrefix}wimage [nombre]` }); await handleWimage(sock, msg, query); break; }
      case 'waifuvideo': { const query = args.slice(1).join(' '); if (!query) return sock.sendMessage(jid, { text: `◇ Uso: ${usedPrefix}waifuvideo [nombre]` }); await handleWaifuVideo(sock, msg, query); break; }
      case 'waifuedit': await handleWaifuEdit({ sock, msg, args, jid }); break;
      case 'vote': await handleVote(sock, msg, args, jid, sender); break;
      case 'harem': await handleHarem(sock, msg, jid, sender, args, mentioned); break;
      case 'delwaifu': await handleDelwaifu(sock, msg, args, jid, sender); break;
      case 'topgacha': await handleTopGacha(sock, msg); break;
      case 'topgachagp': await handleTopGachagp(sock, msg, args, jid); break;
      case 'givechar': await handleGivechar(sock, msg, args, jid, sender, mentioned); break;
      case 'trade': await handleTrade(sock, msg, args, jid, sender); break;
      case 'bal': await handleBal(sock, msg, jid, sender, mentioned); break;
      case 'deposit': await handleDeposit(sock, msg, args, jid, sender); break;
      case 'resetgacha': await handleResetGacha({ sock, jid, msg, sender });break;
      case 'withdraw': await handleWithdraw(sock, msg, args, jid, sender); break;
      case 'w': await handleWork(sock, msg, jid, sender); break;
      case 'slut': await handleSlut(sock, msg, jid, sender); break;
      case 'crime': await handleCrime(sock, msg, jid, sender); break;
      case 'top':
await handleTop(
  sock,
  jid,
  msg,
  args
);
break;
      case 'lvl':
await handleLvl(
  sock,
  jid,
  msg,
  sender
);
break;    
      case 'daily': await handleDaily(sock, msg, jid, sender); break;
      case 'sell': await handleSell(sock, msg, args, jid, sender); break;
      case 'time': await handleTime(sock, msg, args, jid, sender); break;
      case 'cf': await handleCf(sock, msg, args, jid, sender); break;
      case 'status': await handleStatus(sock, msg); break;
      case 'bots': await handleBots(sock, msg); break;
      case 'code': await handleCode(sock, msg, sender); break;
      case 'mute': await handleMute(sock, msg, mentioned, groupData); break;
      case 'unmute': await handleUnmute(sock, msg, mentioned, groupData); break;
      case 'antilink': await handleAntilink(sock, msg, args, groupData); break;
      case 'help': await handleHelp(sock, msg, usedPrefix); break;
      case 'setbanner': await handleSetBanner(sock, msg); break;
      case 'setbotprefix': await handleSetPrefix(sock, msg, args); break;
      case 'infousuario': await handleInfousuario(sock, msg, mentioned, quotedJid, jid); break;
      case 'gp': await handleGp(sock, msg, jid); break;
      case 'pfp': await handlePfp(sock, msg, mentioned); break;
      case 'cleanimg': { const key = args[1]; if (!key) return sock.sendMessage(jid, { text: '◇ Uso: /cleanimg [key]' }); await handleCleanImg(sock, msg, key); break; }
      case 'slist': await handleSlist(sock, msg, args); break;
      case 'ainfo': await handleAinfo(sock, msg, args, jid); break;
      case 'ginfo': await handleGinfo(sock, msg, jid, sender); break;
      case 'bot':

if (args[1] === 'off') {

db.botOff = true;

await sock.sendMessage(jid, {
text: '◇ Bot apagado globalmente.'
}, { quoted: msg });

}

else if (args[1] === 'on') {

db.botOff = false;

await sock.sendMessage(jid, {
text: '✦ Bot encendido globalmente.'
}, { quoted: msg });

}

else if (args[1] === 'offgp') {

groupData.off = true;

await sock.sendMessage(jid, {
text: '◇ Bot apagado en este grupo.'
}, { quoted: msg });

}

else if (args[1] === 'ongp') {

groupData.off = false;

await sock.sendMessage(jid, {
text: '✦ Bot encendido en este grupo.'
}, { quoted: msg });

}

else {

await sock.sendMessage(jid, {
text: '◇ Uso: /bot off/on/offgp/ongp'
}, { quoted: msg });

}

break;

      case 'p': { const start = Date.now(); await sock.sendMessage(jid, { text: `✰ Pong! \`${Date.now() - start}ms\`` }, { quoted: msg }); break; }
    }
  });
}

start();
