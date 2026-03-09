const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, '../data/discourse.db');
const jsonPath = path.join(__dirname, '../data/latest_posts.json');

// Read the JSON data
const rawData = fs.readFileSync(jsonPath);
const { posts } = JSON.parse(rawData);

const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  const stmt = db.prepare('INSERT OR REPLACE INTO posts (' +
    'id, platform, content, timestamp, engagement_count, ' +
    'location, sentiment_indicator, demographics_age, ' +
    'demographics_occupation, ai_relevance_score' +
  ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');

  posts.forEach(post => {
    stmt.run(
      post.id,
      post.platform,
      post.content,
      post.timestamp,
      post.engagement_count,
      post.location || '',
      post.sentiment_indicator || '',
      post.demographics ? post.demographics.age || '' : '',
      post.demographics ? post.demographics.occupation || '' : '',
      post.ai_relevance_score || 0
    );
  });

  stmt.finalize();
  console.log('💾 Loaded ' + posts.length + ' posts into the database');
});

db.close();
