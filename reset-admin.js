'use strict';
// Utilisation : node reset-admin.js NouveauMotDePasse
// Réinitialise le mot de passe du compte administrateur (arrêter le serveur avant).
const fs = require('fs');
const path = require('path');
const { hashPassword } = require('./lib');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const pw = process.argv[2];

(async () => {
  if (!pw || pw.length < 6) { console.error('Usage : node reset-admin.js <nouveau mot de passe (6 caractères min.)>'); process.exit(1); }
  if (!fs.existsSync(DB_FILE)) { console.error('Aucune base trouvée : lance d\'abord le serveur une fois.'); process.exit(1); }
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  const admin = db.users.find((u) => u.role === 'admin');
  if (!admin) { console.error('Aucun administrateur trouvé.'); process.exit(1); }
  admin.passwordHash = await hashPassword(pw);
  db.sessions = {};
  fs.writeFileSync(DB_FILE, JSON.stringify(db));
  console.log(`Mot de passe de « ${admin.username} » réinitialisé.`);
})();
