import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage,
  isJidGroup
} from '@whiskeysockets/baileys';
import P from 'pino';
import fs from 'fs';
import fetch from 'node-fetch';
import readline from 'readline';
import { execSync, spawn } from 'child_process';
import path from 'path';
import crypto from 'crypto';

const SESSION_PATH = './auth';
const TEMP_DIR = './temp';
const CACHE_DIR = './cache';
const AUDIO_CACHE = path.join(CACHE_DIR, 'audio');
const VIDEO_CACHE = path.join(CACHE_DIR, 'video');
const DB_FILE = './database.json';

// Crear carpetas necesarias
for (const dir of [TEMP_DIR, AUDIO_CACHE, VIDEO_CACHE, './subbots']) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━ BASE DE DATOS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
let db = {
  users: {},
  banners: {},
  usedChars: [],
  usedImages: [],
  subbots: {},
  groups: {}
};

if (fs.existsSync(DB_FILE)) {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    db = { ...db, ...parsed };
  } catch {}
}

function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function initUser(sender, pushName) {
  if (!db.users[sender]) {
    db.users[sender] = {
      name: pushName || 'Usuario',
      harem: [],
      garaje: [],
      exp: 0,
      level: 1,
      totalExp: 0,
      totalCommands: 0,
      lastRoll: 0,
      lastClaim: null,
      lastVehicle: null,
      coins: 10000,
      lastWork: 0,
      lastSlut: 0,
      lastCrime: 0,
      lastDaily: 0
    };
  } else {
    const u = db.users[sender];
    u.name = pushName || u.name;
    if (!Array.isArray(u.harem)) u.harem = [];
    if (!Array.isArray(u.garaje)) u.garaje = [];
    if (typeof u.exp !== 'number') u.exp = 0;
    if (typeof u.level !== 'number' || u.level < 1) u.level = 1;
    if (typeof u.totalExp !== 'number') u.totalExp = 0;
    if (typeof u.totalCommands !== 'number') u.totalCommands = 0;
    if (typeof u.coins !== 'number') u.coins = 10000;
  }
  saveDB();
  return db.users[sender];
}

function initGroup(jid) {
  if (!db.groups[jid]) {
    db.groups[jid] = {
      muted: [],
      antilink: false
    };
  }
  saveDB();
  return db.groups[jid];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━ EXPERIENCIA Y NIVELES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function expForLevel(lvl) {
  return Math.floor(100 * Math.pow(1.15, lvl));
}

function addExp(user, exp) {
  user.totalExp = (user.totalExp || 0) + exp;
  user.exp = (user.exp || 0) + exp;
  while (user.exp >= expForLevel(user.level || 1)) {
    user.exp -= expForLevel(user.level || 1);
    user.level = (user.level || 1) + 1;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━ HELPERS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function fetchWithTimeout(url, options = {}, timeout = 15000) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeout);
  try {
    const r = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(tid);
    return r;
  } catch (e) {
    clearTimeout(tid);
    throw e;
  }
}

function resetSession() {
  try { fs.rmSync(SESSION_PATH, { recursive: true, force: true }); } catch {}
}

function askNumber() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(r => rl.question('Número (569XXXXXXXX): ', n => { rl.close(); r(n.replace(/[^0-9]/g, '')); }));
}

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━ YT-DLP ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function ytDlpExec(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(stderr.trim()));
      resolve(stdout.trim());
    });
    proc.on('error', reject);
  });
}

async function ytDlpGetInfo(query) {
  const raw = await ytDlpExec(['-j', '--no-playlist', `ytsearch1:${query}`]);
  return JSON.parse(raw);
}

async function ytDlpDownloadToFile(url, destPath, opts = {}) {
  const args = ['-o', destPath, '--no-playlist', '--max-filesize', '60M'];
  if (opts.audio) {
    args.push('-f', 'bestaudio', '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '320k');
  } else {
    args.push('-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best');
  }
  args.push(url);
  await ytDlpExec(args);
  const base = path.basename(destPath, path.extname(destPath));
  const dir = path.dirname(destPath);
  const files = fs.readdirSync(dir).filter(f => f.startsWith(base));
  if (files.length === 0) throw new Error('Archivo no generado');
  return path.join(dir, files[0]);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━ COMANDOS DE DESCARGA ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleTomp3(sock, msg) {
  const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  if (!quoted?.videoMessage) {
    return sock.sendMessage(msg.key.remoteJid, { text: '◇ Debes citar un video usando !tomp3' }, { quoted: msg });
  }
  await sock.sendMessage(msg.key.remoteJid, { text: 'creando...' }, { quoted: msg });
  try {
    const videoBuffer = await downloadMediaMessage({ key: msg.key, message: quoted }, 'buffer', {});
    const inputPath = path.join(TEMP_DIR, `vid_${Date.now()}.mp4`);
    const outputPath = path.join(TEMP_DIR, `aud_${Date.now()}.mp3`);
    fs.writeFileSync(inputPath, videoBuffer);
    execSync(`ffmpeg -i "${inputPath}" -vn -acodec libmp3lame -b:a 320k "${outputPath}"`, { stdio: 'pipe', timeout: 60000 });
    const audioBuffer = fs.readFileSync(outputPath);
    await sock.sendMessage(msg.key.remoteJid, { audio: audioBuffer, mimetype: 'audio/mpeg', ptt: false }, { quoted: msg });
    fs.unlinkSync(inputPath);
    fs.unlinkSync(outputPath);
  } catch (e) {
    console.error('[tomp3] Error:', e.message);
    await sock.sendMessage(msg.key.remoteJid, { text: '❌ Error al convertir el video a audio' }, { quoted: msg });
  }
}

async function handleTt(sock, msg, url) {
  await sock.sendMessage(msg.key.remoteJid, { text: 'descargando...' }, { quoted: msg });
  try {
    const json = await fetchWithTimeout('https://www.tikwm.com/api/?url=' + encodeURIComponent(url)).then(r => r.json()).catch(() => null);
    if (json?.code === 0 && json.data?.play) {
      return await sendVideoFromUrl(sock, msg, json.data.play || json.data.hdplay, json.data.title, json.data.play_count, json.data.digg_count, json.data.music_info?.title);
    }
    throw new Error('API caída');
  } catch (e) {
    console.error('[tt] Error:', e);
    await sock.sendMessage(msg.key.remoteJid, { text: '● Error al descargar el video de TikTok' }, { quoted: msg });
  }
}

async function sendVideoFromUrl(sock, msg, videoUrl, title, views, likes, music) {
  const cacheKey = md5(videoUrl);
  const cachePath = path.join(VIDEO_CACHE, `${cacheKey}.mp4`);
  let buffer;
  if (fs.existsSync(cachePath)) {
    buffer = fs.readFileSync(cachePath);
  } else {
    const res = await fetchWithTimeout(videoUrl, {}, 60000);
    buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length / 1024 / 1024 <= 60) fs.writeFileSync(cachePath, buffer);
  }
  if (buffer.length / 1024 / 1024 > 60) {
    return sock.sendMessage(msg.key.remoteJid, { text: '● El video es demasiado grande (>60MB)' }, { quoted: msg });
  }
  const caption = `❀ Título » ${title || ''}\n> ❒ Vistas » ${views || 0}\n> ✰ Likes » ${likes || 0}\n> ✐ Música » ${music || 'N/A'}`;
  await sock.sendMessage(msg.key.remoteJid, { video: buffer, caption, mimetype: 'video/mp4' }, { quoted: msg });
}

async function handleMp4(sock, msg, input) {
  await sock.sendMessage(msg.key.remoteJid, { text: 'descargando...' }, { quoted: msg });
  try {
    let urlToDownload = input;
    let title = '';
    if (!isValidUrl(input)) {
      const info = await ytDlpGetInfo(input);
      if (!info) throw new Error('No encontrado');
      urlToDownload = info.webpage_url;
      title = info.title;
    }

    const cacheKey = md5(urlToDownload);
    const cachePath = path.join(VIDEO_CACHE, `${cacheKey}.mp4`);
    let buffer;

    if (fs.existsSync(cachePath)) {
      buffer = fs.readFileSync(cachePath);
    } else {
      const tempDownload = path.join(TEMP_DIR, `raw_${Date.now()}.mp4`);
      const finalPath = await ytDlpDownloadToFile(urlToDownload, tempDownload, { audio: false });
      const rebuiltPath = path.join(TEMP_DIR, `fixed_${Date.now()}.mp4`);
      execSync(`ffmpeg -i "${finalPath}" -c:v libx264 -preset veryfast -crf 23 -c:a aac -movflags +faststart "${rebuiltPath}"`, { stdio: 'pipe', timeout: 60000 });
      if (!fs.existsSync(rebuiltPath)) throw new Error('Error al convertir');
      buffer = fs.readFileSync(rebuiltPath);
      fs.unlinkSync(finalPath);
      if (buffer.length / 1024 / 1024 <= 60) {
        fs.renameSync(rebuiltPath, cachePath);
      } else {
        fs.unlinkSync(rebuiltPath);
      }
    }

    if (buffer.length / 1024 / 1024 > 60) {
      return sock.sendMessage(msg.key.remoteJid, { text: '● El video es demasiado grande (>60MB)' }, { quoted: msg });
    }
    const caption = `❀ Título » ${title || input}\n> Calidad: máxima (HD)\n> Caché: instantáneo`;
    await sock.sendMessage(msg.key.remoteJid, { video: buffer, caption, mimetype: 'video/mp4' }, { quoted: msg });
  } catch (e) {
    console.error('[mp4] Error:', e.message);
    await sock.sendMessage(msg.key.remoteJid, { text: '● Error al descargar el video.' }, { quoted: msg });
  }
}

function isValidUrl(str) { return str.startsWith('http://') || str.startsWith('https://'); }

async function handleYtAudio(sock, msg, query) {/*... igual que antes ...*/}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━ GACHA WAIFUS (SOLO WAIFU.PICS) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function getCharacter() {
  // Anilist
  try {
    const page = Math.floor(Math.random() * 100) + 1;
    const query = `query ($page: Int) { Page(page: $page, perPage: 1) { characters(sort: FAVOURITES_DESC) { id name { full } gender media(sort: POPULARITY_DESC, perPage: 1) { nodes { title { romaji english } } } } } }`;
    const res = await fetchWithTimeout('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ query, variables: { page } })
    }, 15000);
    const json = await res.json();
    const char = json.data?.Page?.characters?.[0];
    if (char && !db.usedChars.includes(char.id)) {
      db.usedChars.push(char.id);
      if (db.usedChars.length > 40000) db.usedChars = [];
      saveDB();
      return {
        id: char.id,
        name: char.name.full || 'Desconocido',
        anime: char.media?.nodes?.[0]?.title?.romaji || char.media?.nodes?.[0]?.title?.english || 'Desconocido',
        gender: char.gender?.toLowerCase().includes('female') ? 'Mujer' : 'Hombre',
        image: null
      };
    }
  } catch {}
  // Jikan fallback
  for (let tries = 0; tries < 10; tries++) {
    try {
      await new Promise(r => setTimeout(r, 200));
      const id = Math.floor(Math.random() * 50000) + 1;
      if (db.usedChars.includes(id)) continue;
      const res = await fetchWithTimeout(`https://api.jikan.moe/v4/characters/${id}/full`, {}, 10000);
      const json = await res.json();
      if (json.data) {
        db.usedChars.push(id);
        if (db.usedChars.length > 40000) db.usedChars = [];
        saveDB();
        return {
          id: json.data.mal_id,
          name: json.data.name,
          anime: json.data.anime?.[0]?.anime?.title || 'Desconocido',
          gender: (json.data.about || '').toLowerCase().includes('female') ? 'Mujer' : 'Hombre',
          image: null
        };
      }
    } catch {}
  }
  return null;
}

async function getWaifuImage() {
  try {
    const res = await fetchWithTimeout('https://api.waifu.pics/sfw/waifu', {}, 10000);
    const json = await res.json();
    if (json.url && !db.usedImages.includes(json.url)) {
      db.usedImages.push(json.url);
      if (db.usedImages.length > 500) db.usedImages = [];
      saveDB();
      return json.url;
    }
  } catch {}
  return 'https://i.imgur.com/removed.png';
}

const RARITIES = [
  { name: '☆ Comun', prob: 0.30, min: 100, max: 500 },
  { name: '◇ Poco Comun', prob: 0.20, min: 500, max: 1000 },
  { name: '♧ Raro', prob: 0.15, min: 1000, max: 2000 },
  { name: '♤ Muy Raro', prob: 0.12, min: 2000, max: 5000 },
  { name: '■ Epico', prob: 0.08, min: 5000, max: 10000 },
  { name: '□ Legendario', prob: 0.05, min: 10000, max: 20000 }
];

function getRarity() {
  let rand = Math.random(), sum = 0;
  for (const r of RARITIES) {
    sum += r.prob;
    if (rand <= sum) return r;
  }
  return RARITIES[0];
}

function isCharOwnedGlobally(id) {
  for (const uid in db.users) {
    const u = db.users[uid];
    if (u && Array.isArray(u.harem) && u.harem.some(c => c.id === id)) return uid;
  }
  return null;
}

async function handleRw(sock, msg, user) {
  const now = Date.now();
  if (now - user.lastRoll < 300000) {
    const wait = Math.ceil((300000 - (now - user.lastRoll)) / 1000);
    return sock.sendMessage(msg.key.remoteJid, { text: `⏳ Debes esperar ${Math.floor(wait/60)}m ${wait%60}s.` }, { quoted: msg });
  }
  await sock.sendMessage(msg.key.remoteJid, { text: 'Buscando waifu...' }, { quoted: msg });
  try {
    let char = await getCharacter();
    if (!char) return sock.sendMessage(msg.key.remoteJid, { text: '● No se encontró personaje.' }, { quoted: msg });
    if (isCharOwnedGlobally(char.id)) return sock.sendMessage(msg.key.remoteJid, { text: '♡ Este personaje ya tiene dueño.' }, { quoted: msg });

    char.image = await getWaifuImage();

    const rarity = getRarity();
    const value = Math.floor(rarity.min + Math.random() * (rarity.max - rarity.min));

    user.lastRoll = now;
    user.lastClaim = {
      ...char,
      value,
      rarity: rarity.name,
      claimed: false,
      image: char.image,
      timestamp: now,
      invoker: msg.key.participant || msg.key.remoteJid
    };
    saveDB();

    const cap = `❀ Nombre » *${char.name}*\n` +
      `⚥ Genero » *${char.gender}*\n` +
      `✰ Valor » *${value}*\n` +
      `♡ Estado » *Libre*\n` +
      `❖ Fuente » *${char.anime}*\n` +
      `☆ Rareza » *${rarity.name}*\n\n` +
      `> Usa !c para reclamar (20s)`;
    await sock.sendMessage(msg.key.remoteJid, { image: { url: char.image }, caption: cap }, { quoted: msg });
  } catch (e) {
    console.error('[rw] Error:', e);
    await sock.sendMessage(msg.key.remoteJid, { text: '● Error al buscar personaje.' }, { quoted: msg });
  }
}

async function handleClaim(sock, msg, user, sender) {/*... igual que antes ...*/}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━ SISTEMA DE AUTOS (!vr CORREGIDO) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const CARS = [
  { name: 'Yamaha R7', speed: 223, price: 46000, type: 'Moto' },
  { name: 'Toyota Supra MK4', speed: 250, price: 50000, type: 'Auto' },
  { name: 'Nissan GT-R R35', speed: 315, price: 80000, type: 'Auto' },
  { name: 'Ford Mustang GT', speed: 250, price: 55000, type: 'Auto' },
  { name: 'Honda Civic Type R', speed: 272, price: 42000, type: 'Auto' },
  { name: 'Lamborghini Huracán', speed: 325, price: 200000, type: 'Auto' },
  { name: 'Ferrari 488', speed: 330, price: 250000, type: 'Auto' },
  { name: 'Ducati Panigale V4', speed: 300, price: 28000, type: 'Moto' },
  { name: 'Kawasaki Ninja H2', speed: 330, price: 32000, type: 'Moto' },
  { name: 'Porsche 911 Turbo', speed: 320, price: 180000, type: 'Auto' }
];

const VEHICLE_RARITIES = [
  { name: 'Épico', prob: 0.40, priceMult: 1.0, speedMult: 1.0 },
  { name: 'Legendario', prob: 0.30, priceMult: 2.0, speedMult: 1.3 },
  { name: 'Mítico', prob: 0.20, priceMult: 5.0, speedMult: 1.6 },
  { name: 'Supremo', prob: 0.10, priceMult: 10.0, speedMult: 2.0 }
];

function getVehicle() {
  const baseCar = CARS[Math.floor(Math.random() * CARS.length)];
  let rand = Math.random(), sum = 0;
  let chosenRarity = VEHICLE_RARITIES[0];
  for (const r of VEHICLE_RARITIES) {
    sum += r.prob;
    if (rand <= sum) { chosenRarity = r; break; }
  }
  const price = Math.floor(baseCar.price * chosenRarity.priceMult);
  const speed = Math.floor(baseCar.speed * chosenRarity.speedMult);
  return {
    name: baseCar.name,
    type: baseCar.type,
    price,
    speed,
    rarity: chosenRarity.name,
    image: null
  };
}

async function handleVr(sock, msg, user) {
  const now = Date.now();
  if (now - user.lastRoll < 300000) {
    const wait = Math.ceil((300000 - (now - user.lastRoll)) / 1000);
    return sock.sendMessage(msg.key.remoteJid, { text: `⏳ Debes esperar ${Math.floor(wait/60)}m ${wait%60}s.` }, { quoted: msg });
  }
  await sock.sendMessage(msg.key.remoteJid, { text: 'Buscando vehículo...' }, { quoted: msg });
  try {
    const vehicle = getVehicle();
    vehicle.image = `https://source.unsplash.com/featured/?${encodeURIComponent(vehicle.name.toLowerCase())},car`;
    user.lastRoll = now;
    user.lastVehicle = {
      ...vehicle,
      timestamp: now,
      claimed: false,
      invoker: msg.key.participant || msg.key.remoteJid
    };
    saveDB();

    const cap = `₍֭⁄⁾֥⁄ּ⁾₎ ͡ ₎ᩥ ${vehicle.type} : *${vehicle.name}*\n\n` +
      `☪︎ Tipo : *${vehicle.rarity}*\n` +
      `⛀ Precio : \`${vehicle.price.toLocaleString()}\`\n` +
      `𖤛 Velocidad : \`${vehicle.speed} KM/H\`\n` +
      `ᜊ Estado : *Disponible*\n\n` +
      `> Reclámalo con *!cv* citando este mensaje`;
    await sock.sendMessage(msg.key.remoteJid, { image: { url: vehicle.image }, caption: cap }, { quoted: msg });
  } catch (e) {
    console.error('[vr] Error:', e);
    await sock.sendMessage(msg.key.remoteJid, { text: '● Error al buscar vehículo.' }, { quoted: msg });
  }
}

async function handleCv(sock, msg, user, sender) {/*... igual que antes ...*/}
async function handleGaraje(sock, msg, user, args, mentioned) {/*...*/}
async function handleGivecar(sock, msg, args, user, mentioned) {/*...*/}
async function handleGiveAllHarem(sock, msg, user, mentioned) {/*...*/}
async function handleGiveAllGaraje(sock, msg, user, mentioned) {/*...*/}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━ ECONOMÍA ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleWork(sock, msg, user) {
  const now = Date.now();
  if (now - user.lastWork < 15000) {
    const wait = Math.ceil((15000 - (now - user.lastWork)) / 1000);
    return sock.sendMessage(msg.key.remoteJid, { text: `⏳ Espera ${wait}s para usar !w` }, { quoted: msg });
  }
  const earned = Math.floor(Math.random() * 10000) + 1000;
  user.coins += earned;
  user.lastWork = now;
  saveDB();
  await sock.sendMessage(msg.key.remoteJid, { text: `✦ Has ganado ¥${earned.toLocaleString()} trabajando.` }, { quoted: msg });
}

async function handleSlut(sock, msg, user) {
  const now = Date.now();
  if (now - user.lastSlut < 240000) {
    const wait = Math.ceil((240000 - (now - user.lastSlut)) / 1000);
    return sock.sendMessage(msg.key.remoteJid, { text: `⏳ Espera ${Math.floor(wait/60)}m ${wait%60}s para usar !slut` }, { quoted: msg });
  }
  const earned = Math.floor(Math.random() * 5000) + 10000;
  user.coins += earned;
  user.lastSlut = now;
  saveDB();
  await sock.sendMessage(msg.key.remoteJid, { text: `✦ Has ganado ¥${earned.toLocaleString()} con !slut.` }, { quoted: msg });
}

async function handleCrime(sock, msg, user) {
  const now = Date.now();
  if (now - user.lastCrime < 300000) {
    const wait = Math.ceil((300000 - (now - user.lastCrime)) / 1000);
    return sock.sendMessage(msg.key.remoteJid, { text: `⏳ Espera ${Math.floor(wait/60)}m ${wait%60}s para usar !crime` }, { quoted: msg });
  }
  const earned = Math.floor(Math.random() * 50000) + 50000;
  user.coins += earned;
  user.lastCrime = now;
  saveDB();
  await sock.sendMessage(msg.key.remoteJid, { text: `✦ Has robado ¥${earned.toLocaleString()} exitosamente.` }, { quoted: msg });
}

async function handleSell(sock, msg, args, user) {
  const name = args.slice(1).join(' ').toLowerCase();
  if (!name) return sock.sendMessage(msg.key.remoteJid, { text: '◇ Uso: !sell [nombre del personaje]' }, { quoted: msg });
  const idx = user.harem.findIndex(c => c.name.toLowerCase().includes(name));
  if (idx === -1) return sock.sendMessage(msg.key.remoteJid, { text: '◇ No tienes ese personaje en tu harem.' }, { quoted: msg });
  const char = user.harem.splice(idx, 1)[0];
  const sellValue = Math.floor(char.value * 1.5);
  user.coins += sellValue;
  saveDB();
  await sock.sendMessage(msg.key.remoteJid, { text: `✦ Vendiste *${char.name}* por ¥${sellValue.toLocaleString()}` }, { quoted: msg });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━ !baltop ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleBaltop(sock, msg, args) {
  const page = parseInt(args[1]) || 1;
  const perPage = 10;
  const all = Object.entries(db.users)
    .filter(([, u]) => u.totalCommands > 0)
    .sort((a, b) => (b[1].coins || 0) - (a[1].coins || 0));
  const pages = Math.ceil(all.length / perPage);
  const slice = all.slice((page-1)*perPage, page*perPage);
  if (!slice.length) return sock.sendMessage(msg.key.remoteJid, { text: '◇ Página vacía.' }, { quoted: msg });
  let text = `『✦』Top Usuarios con más Coins (global)\n\n`;
  slice.forEach(([id, u], i) => {
    text += `✦ ${(page-1)*perPage + i + 1} » ${u.name}\n    ✤ Coins \`${(u.coins || 0).toLocaleString()}\`\n`;
  });
  text += `\n✦ Página \`${page}/${pages}\`  ➭ usa \`!baltop ${page+1}\` para avanzar`;
  await sock.sendMessage(msg.key.remoteJid, { text }, { quoted: msg });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━ !ginfo y !einfo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleGinfo(sock, msg, user) {
  const now = Date.now();
  const rollCooldown = user.lastRoll ? Math.max(0, 300000 - (now - user.lastRoll)) : 0;
  const claimCooldown = user.lastClaim?.timestamp ? Math.max(0, 120000 - (now - user.lastClaim.timestamp)) : 0;
  // Total personajes en waifu.pics (aproximado)
  const totalPics = 50000;
  const totalSeries = 4478; // Anilist series aprox

  const cap = `*❀ Usuario <${user.name}>*\n\n` +
    `ⴵ RollWaifu » *${Math.floor(rollCooldown/60000)} minutos ${Math.floor((rollCooldown%60000)/1000)} segundos*\n` +
    `ⴵ Claim » *${claimCooldown === 0 ? 'Ahora.' : Math.floor(claimCooldown/60000) + ' minutos'}\n` +
    `ⴵ Vote » *Ahora.*\n\n` +
    `♡ Personajes reclamados » *${user.harem.length}*\n` +
    `✰ Valor total » *${user.harem.reduce((s, c) => s + (c.value || 0), 0).toLocaleString()}*\n` +
    `❏ Personajes totales » *${totalPics}*\n` +
    `❏ Series totales » *${totalSeries}*`;
  await sock.sendMessage(msg.key.remoteJid, { text: cap }, { quoted: msg });
}

async function handleEinfo(sock, msg, user) {
  const now = Date.now();
  const workCd = user.lastWork ? Math.max(0, 15000 - (now - user.lastWork)) : 0;
  const slutCd = user.lastSlut ? Math.max(0, 240000 - (now - user.lastSlut)) : 0;
  const crimeCd = user.lastCrime ? Math.max(0, 300000 - (now - user.lastCrime)) : 0;
  const dailyCd = user.lastDaily ? Math.max(0, 86400000 - (now - user.lastDaily)) : 0;

  const formatTime = (ms) => {
    if (ms === 0) return 'Ahora.';
    const h = Math.floor(ms/3600000);
    const m = Math.floor((ms%3600000)/60000);
    const s = Math.floor((ms%60000)/1000);
    return `${h}h ${m}m ${s}s`;
  };

  const cap = `✿ *》》Economía @${user.name}《《* ✿\n\n` +
    `ⴵ Work » *${formatTime(workCd)}*\n` +
    `ⴵ Slut » *${formatTime(slutCd)}*\n` +
    `ⴵ Crime » *${formatTime(crimeCd)}*\n` +
    `ⴵ Daily » *${formatTime(dailyCd)}*\n\n` +
    `⛁ Coins totales » ¥${(user.coins || 0).toLocaleString()} ⋆.*ೃ✧.`;
  await sock.sendMessage(msg.key.remoteJid, { text: cap }, { quoted: msg });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━ MODERACIÓN ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleMute(sock, msg, mentioned, groupData) {
  if (!mentioned.length) return sock.sendMessage(msg.key.remoteJid, { text: '◇ Menciona a un usuario para silenciar.' }, { quoted: msg });
  const target = mentioned[0];
  if (!groupData.muted.includes(target)) {
    groupData.muted.push(target);
    saveDB();
    await sock.sendMessage(msg.key.remoteJid, { text: `🔇 ${db.users[target]?.name || target} ha sido silenciado.` }, { quoted: msg });
  }
}

async function handleUnmute(sock, msg, mentioned, groupData) {
  if (!mentioned.length) return sock.sendMessage(msg.key.remoteJid, { text: '◇ Menciona a un usuario para desilenciar.' }, { quoted: msg });
  const target = mentioned[0];
  groupData.muted = groupData.muted.filter(jid => jid !== target);
  saveDB();
  await sock.sendMessage(msg.key.remoteJid, { text: `🔊 ${db.users[target]?.name || target} puede hablar nuevamente.` }, { quoted: msg });
}

async function handleAntilink(sock, msg, args, groupData) {
  const option = args[1]?.toLowerCase();
  if (option === 'on') {
    groupData.antilink = true;
    saveDB();
    await sock.sendMessage(msg.key.remoteJid, { text: '✅ Antilink activado. Los no admins serán expulsados por enviar enlaces.' }, { quoted: msg });
  } else if (option === 'off') {
    groupData.antilink = false;
    saveDB();
    await sock.sendMessage(msg.key.remoteJid, { text: '❌ Antilink desactivado.' }, { quoted: msg });
  } else {
    await sock.sendMessage(msg.key.remoteJid, { text: `◇ Uso: !antilink on/off (actualmente: ${groupData.antilink ? 'on' : 'off'})` }, { quoted: msg });
  }
}

// En el handler de mensajes, antes de ejecutar comandos, verificar mute y antilink
async function checkModeration(sock, msg, groupData, sender) {
  // Verificar mute
  if (groupData.muted.includes(sender)) {
    await sock.sendMessage(msg.key.remoteJid, { delete: msg.key });
    return true; // mensaje bloqueado
  }
  // Verificar antilink
  if (groupData.antilink) {
    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
    const urlRegex = /https?:\/\/[^\s]+/;
    if (urlRegex.test(text)) {
      // Verificar si es admin
      const meta = await sock.groupMetadata(msg.key.remoteJid);
      const admins = meta.participants.filter(p => p.admin).map(p => p.id);
      if (!admins.includes(sender)) {
        await sock.sendMessage(msg.key.remoteJid, { delete: msg.key });
        await sock.groupParticipantsUpdate(msg.key.remoteJid, [sender], 'remove');
        return true;
      }
    }
  }
  return false;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━ INICIO ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: P({ level: 'silent' }),
    auth: state,
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '20.0.04']
  });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    const sc = lastDisconnect?.error?.output?.statusCode;
    if (connection === 'open') console.log('◇ Conectado');
    if (connection === 'close') {
      if (sc === 401 || sc === DisconnectReason.loggedOut) { resetSession(); setTimeout(start, 2000); return; }
      setTimeout(start, 3000);
    }
  });

  if (!state.creds.registered) {
    const num = await askNumber();
    console.log('Código:', await sock.requestPairingCode(num));
  }

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    try {
      const msg = messages[0];
      if (!msg.message || msg.key.fromMe) return;
      const jid = msg.key.remoteJid;
      if (!jid) return;

      const sender = msg.key.participant || msg.key.remoteJid;
      const pushName = msg.pushName || 'Usuario';
      const user = initUser(sender, pushName);

      // Solo grupos
      if (!jid.endsWith('@g.us')) return;

      const groupData = initGroup(jid);

      // Moderación
      const blocked = await checkModeration(sock, msg, groupData, sender);
      if (blocked) return;

      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
      const args = text.trim().split(' ');
      const cmd = args[0].toLowerCase();
      const ctx = msg.message.extendedTextMessage?.contextInfo;
      const mentioned = ctx?.mentionedJid || [];

      const validPrefixes = ['!', '♠︎'];
      let command = '', usedPrefix = '';
      for (const p of validPrefixes) {
        if (cmd.startsWith(p)) { command = cmd.slice(p.length); usedPrefix = p; break; }
      }
      if (!command) return;

      user.totalCommands++;
      addExp(user, 5);
      saveDB();

      // Enrutador completo (se incluyen todos los comandos nuevos)
      if (command === 'tomp3') await handleTomp3(sock, msg);
      else if (command === 'tt') {
        const url = args[1];
        if (!url?.includes('tiktok.com')) { await sock.sendMessage(jid, { text: `◇ Uso: ${usedPrefix}tt [link]` }, { quoted: msg }); return; }
        await handleTt(sock, msg, url);
      }
      else if (command === 'mp4') {
        const input = args.slice(1).join(' ').trim();
        if (!input) { await sock.sendMessage(jid, { text: `◇ Uso: ${usedPrefix}mp4 [enlace o nombre]` }, { quoted: msg }); return; }
        await handleMp4(sock, msg, input);
      }
      else if (command === 'ytaudio') {
        const query = args.slice(1).join(' ');
        if (!query) { await sock.sendMessage(jid, { text: `◇ Uso: ${usedPrefix}ytaudio [nombre]` }, { quoted: msg }); return; }
        await handleYtAudio(sock, msg, query);
      }
      else if (command === 'rw') await handleRw(sock, msg, user);
      else if (command === 'c') await handleClaim(sock, msg, user, sender);
      else if (command === 'vr') await handleVr(sock, msg, user);
      else if (command === 'cv') await handleCv(sock, msg, user, sender);
      else if (command === 'garaje') await handleGaraje(sock, msg, user, args, mentioned);
      else if (command === 'givecar') await handleGivecar(sock, msg, args, user, mentioned);
      else if (command === 'giveallharem') await handleGiveAllHarem(sock, msg, user, mentioned);
      else if (command === 'giveallgaraje') await handleGiveAllGaraje(sock, msg, user, mentioned);
      else if (command === 'vote') await handleVote(sock, msg, args);
      else if (command === 'harem') await handleHarem(sock, msg, user, args, mentioned);
      else if (command === 'delwaifu') await handleDelwaifu(sock, msg, args, user);
      else if (command === 'topgacha') await handleTopGacha(sock, msg);
      else if (command === 'top') await handleTop(sock, msg, args);
      else if (command === 'baltop') await handleBaltop(sock, msg, args);
      else if (command === 'lvl') await handleLvl(sock, msg, user, mentioned);
      else if (command === 'winfo') {
        const query = args.slice(1).join(' ');
        if (!query) { await sock.sendMessage(jid, { text: `◇ Uso: ${usedPrefix}winfo [nombre]` }, { quoted: msg }); return; }
        await handleWinfo(sock, msg, query);
      }
      else if (command === 'gelbooru') {
        const tags = args.slice(1).join(' ');
        if (!tags) { await sock.sendMessage(jid, { text: `◇ Uso: ${usedPrefix}gelbooru [tags]` }, { quoted: msg }); return; }
        await handleGelbooru(sock, msg, tags);
      }
      else if (command === 'w') await handleWork(sock, msg, user);
      else if (command === 'slut') await handleSlut(sock, msg, user);
      else if (command === 'crime') await handleCrime(sock, msg, user);
      else if (command === 'sell') await handleSell(sock, msg, args, user);
      else if (command === 'ginfo') await handleGinfo(sock, msg, user);
      else if (command === 'einfo') await handleEinfo(sock, msg, user);
      else if (command === 'mute') await handleMute(sock, msg, mentioned, groupData);
      else if (command === 'unmute') await handleUnmute(sock, msg, mentioned, groupData);
      else if (command === 'antilink') await handleAntilink(sock, msg, args, groupData);
      else if (command === 'help') await handleHelp(sock, msg, usedPrefix);
      else if (command === 'setbanner') await handleSetBanner(sock, msg);
      else if (command === 'codw') await handleCodw(sock, msg, args, sender);
      else if (command === 'p') {
        const start = Date.now();
        await sock.sendMessage(jid, { text: `✰ ¡Pong!\n> Tiempo ⴵ ${Date.now() - start}ms` }, { quoted: msg });
      }

    } catch (e) {
      console.error('Error en mensaje:', e);
    }
  });
}

start();
