const AIDiscourseCollector = require('../src/data-collector');

async function testDataCollection() {
    console.log('🧪 Testing AI Discourse Data Collection...\n');
    
    const collector = new AIDiscourseCollector();
    const posts = await collector.collectData();
    
    console.log('\n📊 Collection Results:');
    console.log('- Total posts: ' + posts.length);
    console.log('- Platforms: ' + [...new Set(posts.map(p => p.platform))].join(', '));
    
    if (posts.length > 0) {
        const sample = posts[0];
        console.log('\n📄 Sample post:');
        console.log('ID: ' + sample.id);
        console.log('Platform: ' + sample.platform);
        console.log('Content: ' + sample.content.substring(0, 80) + '...');
        console.log('Relevance: ' + sample.ai_relevance_score);
        console.log('Timestamp: ' + sample.timestamp);
    }
    
    console.log('\n✅ Data collection test PASSED!');
}

testDataCollection();
