import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const dictionarySource = script.match(/const I18N=([\s\S]*?);\nconst TERMS=/)[1];
const termsSource = script.match(/const TERMS=([\s\S]*?);\n/)[1];
const dictionaries = JSON.parse(dictionarySource);
const terms = JSON.parse(termsSource);
const langs = ['zh-CN', 'en', 'ja'];
let checks = 0;
function test(name, fn) { fn(); console.log(`✓ ${name}`); checks++; }
function plain(value) { return JSON.parse(JSON.stringify(value)); }
function page({ language = 'en-US', saved, terms: scores, stats, random = 0.5, brokenStorage = false } = {}) {
  const stored = new Map(Object.entries({ ...(saved ? { pokerLang: saved } : {}), ...(scores ? { pokerTerms: JSON.stringify(scores) } : {}), ...(stats ? { pokerStats: JSON.stringify(stats) } : {}) }));
  const elements = new Map();
  const node = id => {
    if (!elements.has(id)) elements.set(id, {
      innerHTML: '', textContent: '', value: '', dataset: {}, classList: { add() {} }, focus() {}, querySelectorAll() { return []; }
    });
    return elements.get(id);
  };
  const document = { title: '', documentElement: {}, getElementById: node, querySelectorAll() { return []; } };
  const context = vm.createContext({ document, navigator: { language }, localStorage: {
    getItem(k) { if (brokenStorage) throw Error('unavailable'); return stored.get(k) ?? null; },
    setItem(k, v) { if (brokenStorage) throw Error('unavailable'); stored.set(k, v); },
    removeItem(k) { if (brokenStorage) throw Error('unavailable'); stored.delete(k); }
  }, Math: Object.assign(Object.create(Math), { random: () => random }) });
  vm.runInContext(script, context);
  return { evaluate: code => vm.runInContext(code, context), node, document, stored };
}

test('dictionary languages, equal keys, nonempty values and matching interpolation tokens', () => {
  assert.deepEqual(Object.keys(dictionaries), langs);
  const keys = Object.keys(dictionaries.en).sort();
  for (const lang of langs) {
    assert.deepEqual(Object.keys(dictionaries[lang]).sort(), keys);
    for (const key of keys) {
      assert.equal(typeof dictionaries[lang][key], 'string');
      assert.ok(dictionaries[lang][key].trim(), `${lang}.${key}`);
      const tokens = text => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
      assert.deepEqual(tokens(dictionaries[lang][key]), tokens(dictionaries.en[key]), `${lang}.${key} placeholders`);
    }
  }
});
test('English contains no Chinese or Japanese and Japanese interface differs from Chinese', () => {
  for (const [key, value] of Object.entries(dictionaries.en)) assert.doesNotMatch(value, /[\u3040-\u30ff\u4e00-\u9fff]/, key);
  for (const key of Object.keys(dictionaries.ja)) assert.notEqual(dictionaries.ja[key], dictionaries['zh-CN'][key], key);
});
test('all 48 terms have unique stable IDs, aligned translations, nonempty text', () => {
  assert.equal(terms.en.length, 48);
  for (const lang of langs) {
    assert.deepEqual(terms[lang].map(t => t.id), terms.en.map(t => t.id));
    assert.equal(new Set(terms[lang].map(t => t.id)).size, terms[lang].length);
    for (const term of terms[lang]) {
      assert.match(term.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      assert.ok(term.name.trim() && term.meaning.trim());
      if (lang === 'en') assert.doesNotMatch(term.name + term.meaning, /[\u3040-\u30ff\u4e00-\u9fff]/);
      if (lang === 'ja') {
        assert.notEqual(term.name, terms['zh-CN'].find(t => t.id === term.id).name);
        assert.notEqual(term.meaning, terms['zh-CN'].find(t => t.id === term.id).meaning);
      }
    }
  }
});
test('no hard-coded Chinese/Japanese remains outside dictionaries and TERMS', () => {
  const withoutData = html.replace(dictionarySource, '').replace(termsSource, '');
  assert.doesNotMatch(withoutData, /[\u3040-\u30ff\u4e00-\u9fff]/);
  assert.match(html, /"Hiragino Sans","Yu Gothic"/);
});
test('old Chinese term scores migrate, retain mastered total, write back and are idempotent', () => {
  const old = Object.fromEntries(terms['zh-CN'].map((t, i) => [t.name, i % 4]));
  const initialCount = Object.values(old).filter(s => s >= 3).length;
  const p = page({ terms: old });
  const migrated = JSON.parse(p.stored.get('pokerTerms'));
  assert.equal(Object.values(migrated).filter(s => s >= 3).length, initialCount);
  for (const term of terms.en) assert.equal(migrated[term.id], old[terms['zh-CN'].find(t => t.id === term.id).name]);
  assert.deepEqual(plain(p.evaluate(`migrateTermScores(${JSON.stringify(migrated)})`)), migrated);
  assert.equal(Object.keys(migrated).length, 48);
});
test('mixed old/new migration retains highest score, preserving known progress', () => {
  const p = page();
  assert.deepEqual(plain(p.evaluate(`migrateTermScores({'底池赔率 pot odds':3,'pot-odds':1,unknown:2})`)), { 'pot-odds': 3, unknown: 2 });
});
test('navigator fallback, saved preference, html lang and page title', () => {
  for (const [language, expected] of [['zh-TW', 'zh-CN'], ['ja-JP', 'ja'], ['fr-FR', 'en'], ['en-US', 'en']]) {
    const p = page({ language }); assert.equal(p.document.documentElement.lang, expected); assert.equal(p.document.title, dictionaries[expected].title);
  }
  assert.equal(page({ language: 'ja', saved: 'en' }).document.documentElement.lang, 'en');
  assert.equal(page({ language: 'ja', saved: 'invalid' }).document.documentElement.lang, 'ja');
  assert.equal(page({ language: 'zh', brokenStorage: true }).document.documentElement.lang, 'zh-CN');
});
test('language switch re-renders same module and saves preference without changing stats', () => {
  const initial = { rfi: { n: 8, c: 5, miss: ['legacy'] } }, p = page({ stats: initial });
  p.evaluate("cur='chart';show();setLanguage('ja')");
  assert.equal(p.evaluate('cur'), 'chart'); assert.equal(p.document.documentElement.lang, 'ja');
  assert.match(p.node('view').innerHTML, /オープンレンジ一覧/); assert.equal(p.stored.get('pokerLang'), 'ja');
  assert.deepEqual(JSON.parse(p.stored.get('pokerStats')), initial);
  assert.match(p.node('languages').innerHTML, /中文/); assert.match(p.node('languages').innerHTML, /日本語/);
});
test('all modules render and bind in all languages with no missing translations', () => {
  const p = page();
  for (const lang of langs) for (const mod of ['math','rfi','push','chart','terms','stats']) {
    p.evaluate(`lang=${JSON.stringify(lang)};cur=${JSON.stringify(mod)};show()`);
    assert.ok(p.node('view').innerHTML.length > 100);
    assert.doesNotMatch(p.node('view').innerHTML, /undefined|\{\w+\}/, `${lang}.${mod}`);
  }
});
test('flashcards use state.rev independent of translated button text and score stable IDs', () => {
  for (const [random, rev] of [[0.2, true], [0.8, false]]) {
    const p = page({ language: 'ja', random });
    assert.equal(p.evaluate('state.rev'), rev);
    const id = p.evaluate('state.t.id'); const shown = p.evaluate('state.rev?state.t.meaning:state.t.name');
    assert.ok(p.node('view').innerHTML.includes(shown));
    p.node('rv').textContent = 'unrelated'; p.node('rv').onclick(); p.node('yes').onclick();
    assert.equal(JSON.parse(p.stored.get('pokerTerms'))[id], 1);
    const stats = JSON.parse(p.stored.get('pokerStats')); assert.deepEqual(stats.terms, { n: 1, c: 1, miss: [] });
    p.node('rv').onclick(); p.node('no').onclick();
    assert.equal(typeof JSON.parse(p.stored.get('pokerStats')).terms.miss[0], 'object');
  }
});
test('math feedback and structured mistakes translate without changing answers or double-counting', () => {
  const p = page({ random: 0 }); p.evaluate("cur='math';show()");
  assert.equal(p.evaluate('state.ans'), 10 / 50 * 100);
  p.node('in').value = '-1'; p.node('ok').onclick(); p.node('ok').onclick();
  const record = JSON.parse(p.stored.get('pokerStats')).math;
  assert.equal(record.n, 1); assert.equal(record.miss[0].mod, 'math');
  p.evaluate("setLanguage('ja');cur='stats';show()"); assert.match(p.node('view').innerHTML, /必要な最低勝率/);
  p.evaluate("setLanguage('en')"); assert.doesNotMatch(p.node('view').innerHTML, /[\u3040-\u30ff\u4e00-\u9fff]/);
});
test('RFI and push mistakes store decisions/hand/position/stack and translate at display time', () => {
  const p = page();
  p.evaluate("cur='rfi';show();state={pos:'UTG',h:{l:'72o'}}");p.node('r').onclick();
  p.evaluate("cur='push';show();state={pos:'UTG',stack:15,h:{l:'72o'}}");p.node('r').onclick();
  const stored = JSON.parse(p.stored.get('pokerStats'));
  assert.deepEqual(stored.rfi.miss[0], { mod: 'rfi', pos:'UTG', hand:'72o', raise:false });
  assert.equal(stored.push.miss[0].stack,15);assert.equal(stored.push.miss[0].push,false);
  p.evaluate("cur='stats';setLanguage('ja')");assert.match(p.node('view').innerHTML,/フォールド/);
  p.evaluate("setLanguage('en')");assert.match(p.node('view').innerHTML,/Fold/);
});
test('legacy mistakes display unchanged as text; statistics numbers survive new answers', () => {
  const p=page({ stats:{terms:{n:100,c:75,miss:['旧的中文 <img src=x>']}} });
  p.evaluate("cur='stats';show()");assert.match(p.node('view').innerHTML,/旧的中文 &lt;img src=x&gt;/);
  p.evaluate("rec('terms',true,{mod:'terms',termId:'pot-odds'})");
  assert.equal(JSON.parse(p.stored.get('pokerStats')).terms.n,101); assert.equal(JSON.parse(p.stored.get('pokerStats')).terms.c,76);
});
test('math formulas, range tables and borderline push grading stay intact', () => {
  const p = page();
  // Snapshot generated from the pre-i18n main commit: complete RFI/PUSH and all 169 rankings.
  assert.equal(createHash('sha256').update(p.evaluate('JSON.stringify({RFI,PUSH,RANKED})')).digest('hex'),'7331a90475922c59137d600c713e4417ad2daee46eccb7c8912a4e1c70e9aed0');
  assert.equal(p.evaluate('ALL.length'),169);assert.equal(p.evaluate('RFI_SET.UTG.has("AKs")'),true);assert.equal(p.evaluate('RFI_SET.UTG.has("72o")'),false);
  assert.equal(p.evaluate('PUSH.BTN[10]'),47);assert.equal(p.evaluate('PUSH.SB[3]'),100);
  for(const type of ['odds','outs','mdf'])for(const lang of langs){const data={type,P:100,B:50,o:9,flop:true,ans:35};const text=p.evaluate(`lang=${JSON.stringify(lang)};mathText(${JSON.stringify(data)})`);assert.doesNotMatch(text.q+text.expl,/undefined|\{\w+\}/)}
  p.evaluate("cur='push';show();state={pos:'BTN',stack:10,h:{l:Object.keys(RANKED).find(k=>Math.abs(RANKED[k]-47)<=3)}}");p.node('f').onclick();assert.equal(JSON.parse(p.stored.get('pokerStats')).push.c,1);
});
console.log(`\n${checks}/${checks} checks passed`);
