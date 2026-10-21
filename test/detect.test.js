import test from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguages, labelOf, LANG_IDS } from '../lib/detect.js';

const langs = (s) => detectLanguages(s).langs;

test('HTML page with embedded CSS and JS shows all three tags', () => {
  const r = detectLanguages(`<!DOCTYPE html>
<html><head><style>
  body { margin: 0; color: #333; }
  .btn { padding: 8px; }
</style></head>
<body><button class="btn" id="go">Go</button>
<script>
  const el = document.getElementById('go');
  el.addEventListener('click', () => console.log('hi'));
</script></body></html>`);
  assert.deepEqual(r.langs, ['html', 'css', 'javascript']);
  assert.equal(r.primary, 'html');
  assert.deepEqual(r.langs.map(labelOf), ['HTML', 'CSS', 'JS']);
});

test('plain HTML only', () => {
  assert.deepEqual(langs('<div class="a"><p>Hello</p></div>'), ['html']);
});

test('inline style attribute and onclick count as CSS and JS', () => {
  assert.deepEqual(langs('<div style="color: red"><button onclick="go()">x</button></div>'), ['html', 'css', 'javascript']);
});

test('standalone CSS', () => {
  assert.deepEqual(langs('.card {\n  display: flex;\n  gap: 8px;\n}\n@media (max-width: 600px) { .card { display: block; } }'), ['css']);
  assert.deepEqual(langs(':root { --bg: #000; }'), ['css']);
});

test('standalone JavaScript, TypeScript, JSON', () => {
  assert.deepEqual(langs('const x = 5;\nfunction add(a, b) { return a + b; }\nconsole.log(add(x, 2));'), ['javascript']);
  assert.deepEqual(langs('interface User { id: number; name: string }\nconst u: User = { id: 1, name: "a" };\nexport type Id = string;'), ['typescript']);
  assert.deepEqual(langs('{"a": 1, "b": [1, 2, {"c": null}]}'), ['json']);
  assert.deepEqual(langs('[1, 2, 3]'), ['json']);
});

test('JSX is flagged as JavaScript, not just HTML', () => {
  const r = detectLanguages(`import { useState } from 'react';
export default function App() {
  const [n, setN] = useState(0);
  return <div><button onClick={() => setN(n + 1)}>{n}</button></div>;
}`);
  assert.ok(r.langs.includes('javascript'), r.langs.join());
  assert.equal(r.primary, 'javascript');
});

test('Python', () => {
  assert.deepEqual(langs('import os\n\ndef greet(name):\n    if name is None:\n        return "hi"\n    print(f"hello {name}")\n\nclass A:\n    pass'), ['python']);
});

test('Java, C#, C++, C', () => {
  assert.deepEqual(langs('public class Main {\n  public static void main(String[] args) {\n    System.out.println("hi");\n  }\n}'), ['java']);
  assert.deepEqual(langs('using System;\nclass P { static void Main() { Console.WriteLine("hi"); } }'), ['csharp']);
  assert.deepEqual(langs('#include <iostream>\nusing namespace std;\nint main() { cout << "hi" << endl; }'), ['cpp']);
  assert.deepEqual(langs('#include <stdio.h>\nint main(void) {\n  printf("hi\\n");\n  return 0;\n}'), ['c']);
});

test('Go, Rust, Ruby, Kotlin, Swift', () => {
  assert.deepEqual(langs('package main\nimport "fmt"\nfunc main() {\n  x := 1\n  fmt.Println(x)\n}'), ['go']);
  assert.deepEqual(langs('use std::io;\nfn main() {\n  let mut s = String::new();\n  println!("{}", s);\n}'), ['rust']);
  assert.deepEqual(langs('class Dog < Animal\n  attr_accessor :name\n  def speak\n    puts "woof"\n  end\nend'), ['ruby']);
  assert.deepEqual(langs('data class User(val id: Int)\nfun main() {\n  val u = User(1)\n  println(u)\n}'), ['kotlin']);
  assert.deepEqual(langs('import SwiftUI\nstruct V: View {\n  var body: some View { Text("hi") }\n}'), ['swift']);
});

test('PHP inside HTML shows PHP and HTML', () => {
  const r = langs('<?php $name = $_GET["n"]; ?>\n<div><p>Hello <?= $name ?></p></div>');
  assert.deepEqual(r, ['php', 'html']);
});

test('SQL, shell, YAML, Markdown', () => {
  assert.deepEqual(langs('SELECT id, name FROM users WHERE age > 18 ORDER BY name;'), ['sql']);
  assert.deepEqual(langs('select * from orders o left join items i on i.oid = o.id'), ['sql']);
  assert.deepEqual(langs('#!/bin/bash\nset -e\nif [ -f a ]; then\n  echo "yes"\nfi'), ['shell']);
  assert.deepEqual(langs('name: app\nversion: 1.2\nservices:\n  web:\n    image: nginx'), ['yaml']);
  assert.deepEqual(langs('# Title\n\nSome **bold** text and a [link](https://x.y).\n\n- one\n- two'), ['markdown']);
});

test('prose, short input and empty input stay untagged', () => {
  assert.deepEqual(langs('Please select an item from the list and send it to me tomorrow.'), []);
  assert.deepEqual(langs('hello world'), []);
  assert.deepEqual(langs(''), []);
  assert.deepEqual(langs(null), []);
  assert.equal(detectLanguages('').primary, 'plaintext');
});

test('every detected id is a known language and tags never exceed 4', () => {
  const r = detectLanguages('<?php echo 1; ?><style>a{color:red}</style><script>const a=1</script><div></div><p></p>');
  assert.ok(r.langs.length <= 4);
  for (const l of r.langs) assert.ok(LANG_IDS.includes(l), l);
});

test('large input stays fast', () => {
  const big = 'const a = 1;\nconsole.log(a);\n'.repeat(20000);
  const t = performance.now();
  detectLanguages(big);
  assert.ok(performance.now() - t < 200, 'detection took too long');
});
