/* Margin — offline English dictionary (WordNet 3.1), vocabulary with spaced repetition, translation. */

let dictP = null;
export function loadDict() {
  if (!dictP) dictP = (async () => {
    const res = await fetch(new URL('../vendor/wordnet.json.gz', import.meta.url));
    if (!res.ok) throw new Error('The dictionary could not be loaded.');
    const buf = new Uint8Array(await res.arrayBuffer());
    let text;
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
      if (!('DecompressionStream' in window)) throw new Error('This browser cannot unpack the dictionary.');
      text = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    } else text = new TextDecoder().decode(buf); // server already decompressed it
    return JSON.parse(text);
  })().catch(e => { dictP = null; throw e; });
  return dictP;
}

const IRREG = Object.fromEntries(('went:go gone:go was:be were:be been:be am:be is:be are:be had:have has:have did:do done:do does:do said:say made:make ' +
  'took:take taken:take came:come saw:see seen:see knew:know known:know got:get gotten:get gave:give given:give found:find thought:think told:tell ' +
  'became:become left:leave felt:feel brought:bring began:begin begun:begin kept:keep held:hold wrote:write written:write stood:stand heard:hear ' +
  'let:let meant:mean set:set met:meet ran:run paid:pay sat:sit spoke:speak spoken:speak lay:lie lain:lie led:lead read:read grew:grow grown:grow ' +
  'lost:lose fell:fall fallen:fall sent:send built:build understood:understand drew:draw drawn:draw broke:break broken:break spent:spend cut:cut ' +
  'rose:rise risen:rise drove:drive driven:drive bought:buy wore:wear worn:wear chose:choose chosen:choose sought:seek threw:throw thrown:throw ' +
  'caught:catch dealt:deal won:win fought:fight forgot:forget forgotten:forget fled:flee flew:fly flown:fly hung:hang hid:hide hidden:hide ' +
  'sang:sing sung:sing sank:sink sunk:sink slept:sleep spun:spin struck:strike swore:swear sworn:swear swam:swim swum:swim taught:teach tore:tear ' +
  'torn:tear woke:wake woken:wake wept:weep bore:bear borne:bear bound:bind bent:bend bled:bleed blew:blow blown:blow bred:breed dug:dig fed:feed ' +
  'forgave:forgive forgiven:forgive froze:freeze frozen:freeze ground:grind hit:hit hurt:hurt knelt:kneel laid:lay leapt:leap lent:lend lit:light ' +
  'rode:ride ridden:ride rang:ring rung:ring shook:shake shaken:shake shone:shine shot:shoot shut:shut slid:slide smelt:smell sped:speed spilt:spill ' +
  'spat:spit split:split spread:spread sprang:spring stole:steal stolen:steal stuck:stick stung:sting strode:stride strove:strive swept:sweep swung:swing ' +
  'trod:tread wound:wind withdrew:withdraw better:good best:good worse:bad worst:bad men:man women:woman children:child feet:foot teeth:tooth ' +
  'mice:mouse geese:goose people:person lives:life wives:wife knives:knife leaves:leaf wolves:wolf selves:self halves:half').split(' ').map(p => p.split(':')));
const RULES = [['s', ''], ['ses', 's'], ['xes', 'x'], ['zes', 'z'], ['ches', 'ch'], ['shes', 'sh'], ['men', 'man'], ['ies', 'y'],
  ['es', 'e'], ['es', ''], ['ed', 'e'], ['ed', ''], ['ing', 'e'], ['ing', ''], ['er', ''], ['est', ''], ['er', 'e'], ['est', 'e'],
  ['ied', 'y'], ['ier', 'y'], ['iest', 'y'], ['ly', ''], ['ily', 'y']];
function candidates(w) {
  const out = [w];
  if (IRREG[w]) out.push(IRREG[w]);
  for (const [suf, rep] of RULES) if (w.length > suf.length + 2 && w.endsWith(suf)) out.push(w.slice(0, -suf.length) + rep);
  // doubled consonant: "stopped" -> "stop", "running" -> "run"
  const m = w.match(/^(.*?)([bcdfgklmnprstvz])\2(ed|ing|er|est)$/); if (m) out.push(m[1] + m[2]);
  if (w.endsWith("'s") || w.endsWith('’s')) out.push(w.slice(0, -2));
  return [...new Set(out)];
}
const POS = { n: 'noun', v: 'verb', a: 'adjective', r: 'adverb' };
export function normalizeWord(s) {
  return s.trim().toLowerCase().replace(/[“”"‘’'.,;:!?()[\]{}—–-]+$/g, '').replace(/^[“”"‘’'([{—–-]+/g, '').replace(/’/g, "'");
}
export async function lookup(raw) {
  const d = await loadDict();
  const w = normalizeWord(raw);
  for (const c of candidates(w)) {
    let ids = d.w[c] || d.w[c.replace(/-/g, ' ')];
    if (!ids || !ids.length) continue;
    // A lowercase word in the text ("herons", "china") means the common noun, so list proper-noun
    // senses (Heron of Alexandria, China the country) after the others. A capitalised word keeps WordNet's order.
    const capitalised = /^\p{Lu}/u.test(String(raw).trim().replace(/^[^\p{L}]+/u, ''));
    if (!capitalised) {
      const proper = id => !(d.s[id] || '').split('|').some(x => x === c);
      ids = [...ids.filter(id => !proper(id)), ...ids.filter(proper)];
    }
    const groups = new Map();
    for (const id of ids) {
      const p = POS[d.p[id]] || 'other';
      if (!groups.has(p)) groups.set(p, []);
      const g = groups.get(p); if (g.length >= 4) continue;
      const [def, ex] = d.g[id].split('\x1f');
      const syn = (d.s[id] || '').split('|').filter(x => x && x.toLowerCase() !== c).slice(0, 4);
      g.push({ def, ex: ex || '', syn });
    }
    return { word: c, asked: w, groups: [...groups.entries()].map(([pos, senses]) => ({ pos, senses })) };
  }
  return null;
}

/* ---------- vocabulary (Leitner boxes) ---------- */
const DAY = 864e5;
const INTERVAL = [0, 1, 3, 7, 16, 35];
export const vocab = {
  get(store) { return store.get('vocab', []); },
  set(store, l) { store.set('vocab', l); },
  add(store, item) {
    const l = vocab.get(store);
    const ex = l.find(x => x.word === item.word);
    if (ex) { Object.assign(ex, { def: item.def || ex.def, context: item.context || ex.context, updated: Date.now() }); vocab.set(store, l); return false; }
    l.unshift({ ...item, box: 1, due: Date.now(), at: Date.now() });
    vocab.set(store, l); return true;
  },
  due(store) { const now = Date.now(); return vocab.get(store).filter(x => (x.due || 0) <= now); },
  grade(store, word, good) {
    const l = vocab.get(store); const x = l.find(v => v.word === word); if (!x) return;
    x.box = good ? Math.min(5, (x.box || 1) + 1) : 1;
    x.due = Date.now() + (good ? INTERVAL[x.box] * DAY : 10 * 60 * 1000);
    x.reviewed = (x.reviewed || 0) + 1; x.updated = Date.now();
    vocab.set(store, l);
  },
  remove(store, word) { vocab.set(store, vocab.get(store).filter(x => x.word !== word)); }
};

/* ---------- translation ---------- */
export const LANGS = { en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese', nl: 'Dutch', pl: 'Polish', ru: 'Russian', uk: 'Ukrainian', tr: 'Turkish', ar: 'Arabic', hi: 'Hindi', bn: 'Bengali', zh: 'Chinese', ja: 'Japanese', ko: 'Korean', vi: 'Vietnamese', id: 'Indonesian', sv: 'Swedish', yo: 'Yoruba', ha: 'Hausa', ig: 'Igbo', sw: 'Swahili' };
export function canTranslateOnDevice() { return 'Translator' in self; }
export async function translate(text, from, to) {
  if (!('Translator' in self)) return null;
  let src = from;
  try {
    if ((!src || src === 'auto') && 'LanguageDetector' in self) {
      const det = await self.LanguageDetector.create();
      const r = await det.detect(text); src = r && r[0] ? r[0].detectedLanguage : 'en';
    }
  } catch {}
  src = (src || 'en').slice(0, 2);
  if (src === to) return { text, src, same: true };
  const avail = await self.Translator.availability({ sourceLanguage: src, targetLanguage: to });
  if (avail === 'unavailable') return { unavailable: true, src };
  const t = await self.Translator.create({ sourceLanguage: src, targetLanguage: to });
  return { text: await t.translate(text), src };
}
export function webTranslateUrl(text, to) { return `https://translate.google.com/?sl=auto&tl=${encodeURIComponent(to)}&text=${encodeURIComponent(text.slice(0, 4000))}&op=translate`; }
