// update.js
// Usage: node update.js
// It reads update-config.json, downloads the GitHub repo zip, extracts it, backs up current files, and copies new files in place.
//
// IMPORTANT: set update-config.json with your repo details first.

const fs = require('fs');
const https = require('https');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const cwd = process.cwd();
const cfgPath = path.join(cwd, 'update-config.json');

if (!fs.existsSync(cfgPath)) {
  console.error('Missing update-config.json. Create it with { "owner": "...", "repo": "...", "branch": "main" }');
  process.exit(1);
}

const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
if (!cfg.owner || !cfg.repo) {
  console.error('update-config.json must include "owner" and "repo".');
  process.exit(1);
}
const branch = cfg.branch || 'main';

const zipUrl = `https://github.com/${cfg.owner}/${cfg.repo}/archive/refs/heads/${branch}.zip`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'game-show-update-'));
const zipPath = path.join(tmpDir, 'repo.zip');
const extractDir = path.join(tmpDir, 'extracted');

console.log('Downloading update from:', zipUrl);
const file = fs.createWriteStream(zipPath);
https.get(zipUrl, (res) => {
  if (res.statusCode !== 200) {
    console.error(`Failed to download archive (status ${res.statusCode}). Check repo/branch and that repo is public.`);
    process.exit(1);
  }
  res.pipe(file);
  file.on('finish', () => {
    file.close(() => {
      console.log('Downloaded to', zipPath);
      // Use PowerShell Expand-Archive on Windows (this script assumes Windows)
      const isWin = process.platform === 'win32';
      if (!isWin) {
        console.error('This updater script currently supports Windows (uses PowerShell Expand-Archive). For other OS, extract the zip manually.');
        process.exit(1);
      }
      fs.mkdirSync(extractDir);
      const cmd = `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`;
      console.log('Extracting archive...');
      exec(cmd, (err, stdout, stderr) => {
        if (err) {
          console.error('Error extracting archive:', stderr || err.message);
          process.exit(1);
        }
        console.log('Extracted to', extractDir);
        // The extracted folder will be like <repo>-main
        const extractedChildren = fs.readdirSync(extractDir).filter(n => n && n !== '.' && n !== '..');
        if (extractedChildren.length === 0) {
          console.error('No files found in extracted archive.');
          process.exit(1);
        }
        const repoRoot = path.join(extractDir, extractedChildren[0]);

        // Backup current project
        const backupsDir = path.join(cwd, 'backups');
        if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir);
        const ts = new Date().toISOString().replace(/[:.]/g,'-');
        const backupPath = path.join(backupsDir, `backup-${ts}`);
        fs.mkdirSync(backupPath);
        console.log('Backing up current files to', backupPath);

        // Copy everything except node_modules and backups into backup
        const itemsToBackup = fs.readdirSync(cwd).filter(n => n !== 'node_modules' && n !== 'backups' && n !== '.git' && n !== 'update-config.json');
        itemsToBackup.forEach(name => {
          const src = path.join(cwd, name);
          const dest = path.join(backupPath, name);
          copyRecursiveSync(src, dest);
        });

        // Now copy new files from repoRoot into cwd (overwrite)
        console.log('Applying update from', repoRoot);
        copyRecursiveSync(repoRoot, cwd);

        console.log('Update applied. Clean up temporary files at', tmpDir);
        // do not delete backups
        console.log('Backup was saved at', backupPath);
        console.log('IMPORTANT: restart your server (Ctrl+C if running) then run: npm start');
      });
    });
  });
}).on('error', (err) => {
  console.error('Download error:', err.message);
  process.exit(1);
});

function copyRecursiveSync(src, dest) {
  const stat = fs.existsSync(src) && fs.statSync(src);
  if (!stat) return;
  if (stat.isDirectory()) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest);
    const entries = fs.readdirSync(src);
    entries.forEach(entry => {
      // skip node_modules and .git in incoming repo
      if (entry === 'node_modules' || entry === '.git') return;
      copyRecursiveSync(path.join(src, entry), path.join(dest, entry));
    });
  } else {
    fs.copyFileSync(src, dest);
  }
}
