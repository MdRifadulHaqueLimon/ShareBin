// Automatic language detection from pasted code. Pure JS: runs in the browser (live tags)
// and on the server (validation / fallback), so both always agree.
//
//   detectLanguages('<style>a{color:red}</style><script>let x=1</script><p>hi</p>')
//   -> { langs: ['html', 'css', 'javascript'], primary: 'html' }
//
// `langs` is every language found (max 4, display order). `primary` is a Monaco language id.

export const LANGUAGES = {
  html: 'HTML', css: 'CSS', javascript: 'JS', typescript: 'TS', php: 'PHP', python: 'Python',
  java: 'Java', csharp: 'C#', cpp: 'C++', c: 'C', go: 'Go', rust: 'Rust', ruby: 'Ruby',
  kotlin: 'Kotlin', swift: 'Swift', sql: 'SQL', shell: 'Shell', json: 'JSON', yaml: 'YAML',
  markdown: 'Markdown',
};
export const LANG_IDS = Object.keys(LANGUAGES);
export const isLang = (id) => LANG_IDS.includes(id);
export const labelOf = (id) => LANGUAGES[id] ?? 'Plain text';

const MAX_SCAN = 30_000;      // only look at the first 30k characters: keeps typing lag-free
const MAX_TAGS = 4;
const THRESHOLD = 3;          // minimum score for a general-purpose language
const DISPLAY_ORDER = ['php', 'html', 'css', 'javascript', 'typescript'];

const count = (s, re) => (s.match(re) || []).length;
const score = (s, rules) => rules.reduce((t, [re, w, cap = 1]) => t + Math.min(count(s, re), cap) * w, 0);

// ---- general-purpose language rules: [regex, weight, max matches counted] -------------------
const JS = [
  [/\b(?:const|let)\s+[\w$]+\s*=/g, 3], [/\bvar\s+[\w$]+\s*=/g, 2],
  [/\bfunction\b\s*[\w$]*\s*\(/g, 3], [/=>/g, 1], [/console\.(?:log|error|warn|info)\(/g, 4],
  [/\b(?:document|window)\.[a-zA-Z]/g, 3], [/\b(?:addEventListener|querySelector(?:All)?|getElementById)\b/g, 3],
  [/\brequire\(\s*['"]/g, 3], [/^\s*import\s[^;\n]+\sfrom\s+['"]/gm, 3], [/\bexport\s+(?:default|const|function|class)\b/g, 3],
  [/\bmodule\.exports\b/g, 4], [/[^=!]===|!==/g, 2], [/\bawait\s/g, 1], [/\bnew Promise\(|\.then\(/g, 2],
  [/\bJSON\.(?:parse|stringify)\(/g, 3], [/\.(?:map|filter|reduce|forEach)\(/g, 2],
  [/\bexport\s+default\s+function\b|\buse(?:State|Effect|Ref)\(/g, 2],
];
const TS_ONLY = [
  [/:\s*(?:string|number|boolean|any|void|unknown|never)\b(?:\[\])?/g, 3], [/^\s*(?:export\s+)?interface\s+\w+/gm, 4],
  [/^\s*(?:export\s+)?type\s+\w+(?:<[^>]*>)?\s*=/gm, 3], [/\bas\s+(?:const|string|number|any|unknown)\b/g, 2],
  [/\b(?:enum|readonly|namespace|declare)\s+\w+/g, 1], [/<[A-Z]\w*(?:\s*,\s*[A-Z]\w*)*>\s*\(/g, 1],
];
const RULES = {
  javascript: JS,
  python: [
    [/^\s*def\s+\w+\s*\(.*\)\s*(?:->\s*[^:]+)?:\s*$/gm, 5], [/^\s*class\s+\w+(?:\(.*\))?:\s*$/gm, 4],
    [/^\s*(?:from\s+[\w.]+\s+)?import\s+[\w., *]+\s*$/gm, 2], [/^\s*(?:if|elif|else|for|while|try|except|finally|with)\b[^\n]*:\s*$/gm, 2, 2],
    [/\belif\b/g, 3], [/\bself\./g, 2], [/\b(?:None|True|False)\b/g, 2], [/__\w+__/g, 2],
    [/\bin\s+range\(/g, 3], [/\bf["'][^"'\n]*\{/g, 2], [/\bprint\(/g, 1], [/\blambda\b[^:\n]*:/g, 2],
  ],
  java: [
    [/\bSystem\.out\.print/g, 6], [/\bpublic\s+static\s+void\s+main\b/g, 6], [/^\s*import\s+java[x]?\./gm, 5],
    [/\bpublic\s+(?:static\s+)?(?:final\s+)?(?:class|interface|enum)\b/g, 3], [/@Override\b/g, 3],
    [/\b(?:ArrayList|HashMap|List|Map)<\w+/g, 2], [/\b(?:extends|implements)\s+\w+/g, 1], [/^\s*package\s+[\w.]+;/gm, 2],
    [/\bprivate\s+(?:final\s+)?\w+\s+\w+\s*[;=(]/g, 2], [/\bString\s+\w+\s*[=;(]/g, 1],
  ],
  csharp: [
    [/\busing\s+System\b/g, 6], [/\bConsole\.(?:WriteLine|Write|ReadLine)\(/g, 6], [/\{\s*get;\s*(?:set;)?\s*\}/g, 5],
    [/\bnamespace\s+[\w.]+\s*[{;]/g, 2], [/\bpublic\s+(?:static\s+)?(?:async\s+)?(?:class|void|string|int|Task)\b/g, 2],
    [/\basync\s+Task\b/g, 4], [/\bforeach\s*\(\s*(?:var|\w+)\s+\w+\s+in\b/g, 3], [/^\s*\[(?:Serializable|HttpGet|HttpPost|Route|Fact|Test)\b/gm, 3],
    [/\bstring\[\]/g, 2], [/\bvar\s+\w+\s*=\s*new\b/g, 1],
  ],
  cpp: [
    [/#include\s*<(?:iostream|vector|string|map|set|algorithm|memory|cmath|sstream|fstream)>/g, 6], [/\bstd::/g, 5],
    [/\bcout\s*<<|\bcin\s*>>/g, 5], [/\busing\s+namespace\s+std\b/g, 5], [/\btemplate\s*<\s*(?:typename|class)\b/g, 4],
    [/\bnullptr\b/g, 3], [/\bendl\b/g, 2], [/\b(?:virtual|constexpr|noexcept)\b/g, 2], [/\bint\s+main\s*\(/g, 2], [/\bclass\s+\w+\s*(?::\s*(?:public|private)\s+\w+)?\s*\{/g, 1],
  ],
  c: [
    [/#include\s*<(?:stdio|stdlib|string|math|unistd|stdint|stdbool|ctype|time)\.h>/g, 6], [/\bprintf\s*\(/g, 3], [/\bscanf\s*\(/g, 3],
    [/\b(?:malloc|calloc|free)\s*\(/g, 3], [/\bint\s+main\s*\(/g, 3], [/\btypedef\b/g, 3], [/\bsizeof\b/g, 2], [/\bNULL\b/g, 2],
    [/#define\s+\w+/g, 2], [/\bchar\s*\*/g, 3], [/\bstruct\s+\w+\s*\{/g, 1],
  ],
  go: [
    [/^\s*package\s+\w+\s*$/gm, 4], [/\bfunc\s+(?:\(\s*\w+\s+\*?\w+\s*\)\s*)?\w+\s*\(/g, 4], [/\bfmt\.(?:Print|Sprintf|Errorf|Fprintf)/g, 5],
    [/\w\s*:=\s*\S/g, 3], [/\bgo\s+func\b|\bdefer\s+\w|\bchan\s+\w/g, 3], [/^\s*import\s*\(\s*\n\s*"/gm, 4],
    [/\bif\s+err\s*!=\s*nil\b/g, 5], [/\bnil\b/g, 1], [/\[\]\w+\{/g, 1],
  ],
  rust: [
    [/\bfn\s+\w+\s*(?:<[^>]*>)?\s*\(/g, 4], [/\blet\s+mut\b/g, 5], [/\b(?:println|print|format|vec|panic|assert_eq)!\s*[(\[]/g, 6],
    [/^\s*use\s+(?:std|crate|super|self)::/gm, 6], [/\bimpl(?:\s*<[^>]*>)?\s+\w+/g, 3], [/\b(?:pub\s+)?(?:struct|enum|trait)\s+\w+/g, 2],
    [/&mut\b|&'\w+/g, 3], [/\bSome\(|\bOk\(|\bErr\(/g, 3], [/\.unwrap\(\)|\.expect\(/g, 3], [/#\[derive\(/g, 5], [/\w::new\(/g, 1],
  ],
  php: [
    [/<\?php/g, 8], [/<\?=/g, 5], [/\$this->/g, 4], [/\$_(?:GET|POST|SERVER|SESSION|REQUEST|COOKIE|FILES)\b/g, 6],
    [/\bforeach\s*\(\s*\$\w+\s+as\b/g, 5], [/\bpublic\s+function\s+\w+/g, 3], [/\$\w+\s*=\s*[^=]/g, 2, 2],
    [/\barray\s*\(/g, 2], [/\b(?:var_dump|print_r|isset|empty)\s*\(/g, 3], [/\bmysqli_\w+|\bnew\s+PDO\b/g, 4], [/\becho\s+[^;\n]*;/g, 2], [/->\w+\(/g, 1],
  ],
  ruby: [
    [/^\s*end\s*$/gm, 4], [/^\s*def\s+\w+[?!]?(?:\([^)]*\))?\s*$/gm, 4], [/\bputs\s+\S/g, 3], [/\battr_(?:accessor|reader|writer)\b/g, 5],
    [/\bdo\s*\|\w+(?:,\s*\w+)*\|/g, 4], [/\.each(?:_with_index)?\s+do\b/g, 3], [/\b(?:elsif|unless)\b/g, 4], [/#\{[^}]*\}/g, 3],
    [/^\s*(?:class\s+\w+(?:\s*<\s*[\w:]+)?|module\s+\w+)\s*$/gm, 3], [/\brequire\s+['"]/g, 2], [/:\w+\s*=>/g, 2],
  ],
  kotlin: [
    [/\bfun\s+\w+\s*\(/g, 5], [/\bval\s+\w+\s*(?::\s*[\w<>?]+)?\s*=/g, 4], [/\bdata\s+class\b/g, 6], [/\boverride\s+fun\b/g, 5],
    [/\bwhen\s*(?:\([^)]*\))?\s*\{/g, 4], [/\b(?:companion\s+object|lateinit|suspend\s+fun)\b/g, 5], [/\bimport\s+(?:kotlin|android|androidx)\./g, 5],
    [/\bvar\s+\w+\s*:\s*\w+/g, 2], [/\?\.|\?:/g, 2], [/\bprintln\(/g, 2],
  ],
  swift: [
    [/\bimport\s+(?:UIKit|SwiftUI|Foundation|Combine|AppKit)\b/g, 7], [/\bguard\s+(?:let|var)?[^\n]*\belse\b/g, 5], [/\bif\s+let\b/g, 4],
    [/\bstruct\s+\w+\s*:\s*(?:View|Codable|Identifiable|Hashable)\b/g, 7], [/@(?:State|Binding|Published|ObservedObject|StateObject|main|IBOutlet|IBAction)\b/g, 6],
    [/\bvar\s+body\s*:\s*some\s+View\b/g, 7], [/\bfunc\s+\w+\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?:throws\s*)?->/g, 3], [/\boverride\s+func\b/g, 5],
    [/\b(?:protocol|extension)\s+\w+/g, 3], [/\b(?:let|var)\s+\w+\s*:\s*[A-Z]\w*/g, 2],
  ],
  shell: [
    [/^#!\s*\/(?:usr\/)?bin\/(?:env\s+)?(?:ba|z|da|k)?sh\b/gm, 8], [/^\s*(?:sudo|apt(?:-get)?|yum|brew|npm|pip3?|git|cd|ls|mkdir|chmod|chown|curl|wget|docker|export|source|rm|cp|mv)\s+\S/gm, 2, 3],
    [/\bif\s+\[\[?\s/g, 4], [/\b(?:fi|esac|done)\b\s*$/gm, 3], [/^\s*(?:echo|printf)\s/gm, 2], [/\|\s*(?:grep|awk|sed|sort|head|tail|wc|xargs|uniq|tee)\b/g, 3],
    [/^\s*\$\s+\S/gm, 3], [/\bfor\s+\w+\s+in\b[^\n]*;\s*do\b/g, 4], [/\b[A-Za-z_]\w*=\$\(/g, 3], [/>\s*\/dev\/null|2>&1/g, 4], [/\$\{?[A-Za-z_]\w*\}?/g, 1, 2],
  ],
  sql: [
    [/\bselect\s+(?:\*|[\w.]+(?:\s*,\s*[\w.]+)*|\w+\([^)]*\)(?:\s+as\s+\w+)?)\s+from\s+[\w."`]+/gi, 6], [/\binsert\s+into\s+[\w."`]+/gi, 6],
    [/\bupdate\s+[\w."`]+\s+set\b/gi, 6], [/\bdelete\s+from\s+[\w."`]+/gi, 6], [/\bcreate\s+(?:or\s+replace\s+)?(?:table|index|view|database|function|procedure)\b/gi, 6],
    [/\b(?:alter|drop)\s+table\b/gi, 6], [/\b(?:where|group\s+by|order\s+by|inner\s+join|left\s+join|having)\b/gi, 2, 2],
    [/\b(?:primary\s+key|varchar\s*\(|not\s+null|foreign\s+key)\b/gi, 3],
  ],
  markdown: [
    [/^#{1,6}\s+\S/gm, 2], [/^```\w*\s*$/gm, 4], [/\[[^\]\n]+\]\([^)\n]+\)/g, 3], [/\*\*[^*\n]+\*\*/g, 2],
    [/^\s*[-*]\s+\S/gm, 1, 2], [/^>\s+\S/gm, 1], [/^\s*\d+\.\s+\S/gm, 1],
  ],
};
const ALL_GENERAL = Object.keys(RULES);
const WEB_GENERAL = ['javascript', 'php'];          // allowed inside HTML text

// ---- helpers ---------------------------------------------------------------------------------
function tryJson(s) {
  const t = s.trim();
  if (!/^[{[]/.test(t) || !/[}\]]$/.test(t)) return false;
  try { const v = JSON.parse(t); return typeof v === 'object' && v !== null; } catch { return false; }
}

const HTML_TAGS = 'a|abbr|article|aside|audio|b|body|br|button|canvas|code|div|em|footer|form|h[1-6]|head|header|hr|html|i|iframe|img|input|label|li|link|main|meta|nav|ol|option|p|pre|script|section|select|small|source|span|strong|style|svg|table|tbody|td|textarea|th|thead|title|tr|ul|video';
const TAG_RE = new RegExp(`<\\/?(?:${HTML_TAGS})(?=[\\s/>])[^<>]*>`, 'gi');
const isHtml = (s) => /<!doctype\s+html/i.test(s) || /<\/?(?:html|head|body)[\s>]/i.test(s) || count(s, TAG_RE) >= 2;

const CSS_PROPS = '(?:color|background|margin|padding|border|font|display|width|height|min|max|position|top|left|right|bottom|flex|grid|gap|align|justify|text|line|letter|word|white|opacity|transform|transition|animation|z-index|overflow|content|cursor|box|float|clear|visibility|outline|list|vertical|filter|backdrop|object|resize|pointer|user|will|inset|--[\\w-]+)';
const CSS_DECL_RE = new RegExp(`(?:^|[;\\s])${CSS_PROPS}[\\w-]*\\s*:\\s*[^;]+`, 'i');
// Linear scan over {...} bodies (a "selector { a: b; }" regex backtracks badly on big inputs).
// A body counts as CSS when it has a known property AND looks like declarations, not a JS object
// literal: either it uses ";" separators, or it has no quotes / top-level commas.
function hasCssRule(s) {
  for (const m of s.matchAll(/\{([^{}]{1,2000})\}/g)) {
    const body = m[1];
    if (!CSS_DECL_RE.test(body)) continue;
    if (body.includes(';') || !/[,'"`]/.test(body.replace(/\([^)]*\)/g, ''))) return true;
  }
  return (/@(?:media|import|keyframes|font-face|charset)\b/.test(s) && /\{/.test(s)) || /(?:^|\s):root\s*\{/.test(s);
}

function yamlScore(s) {
  const lines = s.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (lines.length < 2) return 0;
  const kv = lines.filter((l) => /^\s*(?:-\s+)?[\w.-]+:(?:\s+\S.*|\s*)$/.test(l) && !/[;{}()]/.test(l)).length;
  if (kv / lines.length < 0.6) return 0;
  return Math.min(kv, 6) + (/^---\s*$/m.test(s) ? 2 : 0);
}

function bestGeneral(text, allowed) {
  if (!text.trim()) return { lang: null, score: 0 };
  const jsScore = score(text, JS);
  const tsOnly = score(text, TS_ONLY);
  const scores = {};
  for (const id of allowed) {
    if (id === 'javascript') scores.javascript = jsScore;
    else if (id === 'typescript' || id === 'yaml') continue;      // typescript/yaml are scored separately below
    else scores[id] = score(text, RULES[id]);
  }
  if (allowed.includes('javascript') && tsOnly >= 3) { scores.typescript = jsScore + tsOnly; delete scores.javascript; }
  if (allowed.includes('yaml')) scores.yaml = yamlScore(text);
  let lang = null, best = 0;
  for (const [id, sc] of Object.entries(scores)) if (sc > best) { lang = id; best = sc; }
  // C vs C++ share syntax; a C++-only construct must win outright
  return best >= THRESHOLD ? { lang, score: best } : { lang: null, score: best };
}

const stripHtml = (s) => s
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ').replace(TAG_RE, ' ');

// ---- public API ------------------------------------------------------------------------------
export function detectLanguages(input) {
  const full = String(input ?? '');
  if (full.trim().length < 3) return { langs: [], primary: 'plaintext' };
  if (tryJson(full)) return { langs: ['json'], primary: 'json' };

  const src = full.slice(0, MAX_SCAN);
  const found = new Set();
  let jsx = false;

  if (isHtml(src)) {
    found.add('html');
    const styles = [...src.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
    if (styles.length || /\sstyle\s*=\s*["'][^"']*:/i.test(src)) found.add('css');
    const scripts = [...src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
    const hasScriptTag = /<script\b/i.test(src);
    if (hasScriptTag || /\son[a-z]+\s*=\s*["']/i.test(src)) found.add('javascript');
    const text = scripts.join('\n') + '\n' + stripHtml(src);
    const g = bestGeneral(text, WEB_GENERAL);
    if (g.lang === 'php') found.add('php');
    if (g.lang === 'javascript' || g.lang === 'typescript') {
      found.delete('javascript'); found.add(g.lang);
      if (!hasScriptTag && g.score >= 5) jsx = true;          // JSX/TSX: markup mixed straight into code
    }
  } else {
    if (hasCssRule(src)) found.add('css');
    const g = bestGeneral(src, ALL_GENERAL.concat('yaml', 'typescript'));
    // when CSS was found, only add a second language if it is clearly present
    if (g.lang && (!found.has('css') || g.score >= 6)) found.add(g.lang);
  }

  const order = (id) => { const i = DISPLAY_ORDER.indexOf(id); return i === -1 ? 99 : i; };
  const langs = [...found].sort((a, b) => order(a) - order(b)).slice(0, MAX_TAGS);
  let primary = langs[0] ?? 'plaintext';
  if (jsx) primary = langs.find((l) => l === 'javascript' || l === 'typescript') ?? primary;
  return { langs, primary };
}
