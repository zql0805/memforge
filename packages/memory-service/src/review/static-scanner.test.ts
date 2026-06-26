import { describe, it, expect } from 'vitest';
import { scanDiff } from './static-scanner.js';

describe('static-scanner', () => {
  describe('scanDiff', () => {
    it('检测 SQL 拼接注入风险', () => {
      const diff = `
+++ b/src/UserController.java
@@ -10,0 +11,3 @@
+    String sql = "SELECT * FROM users WHERE id = " + userId + "";
+    db.execute(sql);
`;
      const findings = scanDiff(diff, ['src/UserController.java']);
      const sqlFindings = findings.filter(f => f.category === 'security');
      expect(sqlFindings.length).toBeGreaterThanOrEqual(1);
      expect(sqlFindings[0].severity).toBe('P0');
    });

    it('检测空 catch 块', () => {
      const diff = `
+++ b/src/Service.ts
@@ -1,0 +2,5 @@
+try {
+  doSomething();
+} catch (e) {}
`;
      const findings = scanDiff(diff, ['src/Service.ts']);
      const exceptionFindings = findings.filter(f => f.category === 'exception');
      expect(exceptionFindings.length).toBe(1);
      expect(exceptionFindings[0].severity).toBe('P1');
    });

    it('检测 console.log 残留（仅 JS/TS 文件）', () => {
      const diff = `
+++ b/src/utils.ts
@@ -1,0 +2,1 @@
+console.log("debug info");
`;
      const findings = scanDiff(diff, ['src/utils.ts']);
      const conventions = findings.filter(f => f.ruleRef === 'console-log');
      expect(conventions.length).toBe(1);
      expect(conventions[0].severity).toBe('P2');
    });

    it('不误报非 JS/TS 文件中的 console.log', () => {
      const diff = `
+++ b/docs/guide.md
@@ -1,0 +2,1 @@
+console.log("example");
`;
      const findings = scanDiff(diff, ['docs/guide.md']);
      const conventions = findings.filter(f => f.ruleRef === 'console-log');
      expect(conventions.length).toBe(0);
    });

    it('检测硬编码密钥', () => {
      const diff = `
+++ b/config.ts
@@ -1,0 +2,1 @@
+const apikey = "sk-abcdef1234567890abcdef";
`;
      const findings = scanDiff(diff, ['config.ts']);
      const secretFindings = findings.filter(f => f.ruleRef === 'hardcoded-secret');
      expect(secretFindings.length).toBe(1);
      expect(secretFindings[0].severity).toBe('P0');
    });

    it('检测 SELECT * 查询', () => {
      const diff = `
+++ b/src/dao.ts
@@ -1,0 +2,1 @@
+const rows = await db.query("SELECT * FROM orders WHERE id = $1", [id]);
`;
      const findings = scanDiff(diff, ['src/dao.ts']);
      const perf = findings.filter(f => f.ruleRef === 'sql-select-star');
      expect(perf.length).toBe(1);
      expect(perf[0].severity).toBe('P2');
    });

    it('检测 CORS 允许所有来源', () => {
      const diff = `
+++ b/nginx.conf
@@ -1,0 +2,1 @@
+add_header 'Access-Control-Allow-Origin' '*';
`;
      const findings = scanDiff(diff, ['nginx.conf']);
      const cors = findings.filter(f => f.ruleRef === 'cors-allow-all');
      expect(cors.length).toBe(1);
      expect(cors[0].severity).toBe('P1');
    });

    it('无新增行时返回空结果', () => {
      const diff = `
+++ b/src/clean.ts
@@ -1,3 +1,3 @@
-const old = 1;
+const updated = 1;
`;
      const findings = scanDiff(diff, ['src/clean.ts']);
      expect(findings.length).toBe(0);
    });

    it('同一文件相近行不重复报告', () => {
      const diff = `
+++ b/src/bad.ts
@@ -10,0 +11,3 @@
+console.log("a");
+console.log("b");
+console.log("c");
`;
      const findings = scanDiff(diff, ['src/bad.ts']);
      const consoleLogs = findings.filter(f => f.ruleRef === 'console-log');
      expect(consoleLogs.length).toBe(1);
    });
  });
});
