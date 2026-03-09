const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '../data/discourse.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run('CREATE TABLE IF NOT EXISTS posts (' +
    'id TEXT PRIMARY KEY, ' +
    'platform TEXT, ' +
    'content TEXT, ' +
    'timestamp TEXT, ' +
    'engagement_count INTEGER, ' +
    'location TEXT, ' +
    'sentiment_indicator TEXT, ' +
    'demographics_age TEXT, ' +
    'demographics_occupation TEXT, ' +
    'ai_relevance_score REAL' +
  ')');

  console.log('✅ Database initialized at', dbPath);
});

db.close();
