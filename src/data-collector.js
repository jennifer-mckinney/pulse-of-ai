const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

class AIDiscourseCollector {
    constructor() {
        this.dataDir = path.join(__dirname, '../data');
        this.ensureDataDirectory();
    }

    ensureDataDirectory() {
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }

    generateMockAIPost() {
        const aiTopics = [
            'artificial intelligence breakthrough in healthcare',
            'ChatGPT impact on education system',
            'AI job displacement concerns growing',
            'machine learning bias in hiring practices',
            'autonomous vehicles safety regulations needed',
            'AI art controversy over human creativity',
            'deepfake technology threatens democracy',
            'AI assistant privacy data collection issues'
        ];
        
        const sentiments = ['positive', 'negative', 'neutral'];
        const locations = ['New York', 'San Francisco', 'London', 'Toronto', 'Sydney'];
        const demographics = [
            { age: '18-24', occupation: 'student' },
            { age: '25-34', occupation: 'developer' },
            { age: '35-44', occupation: 'researcher' },
            { age: '45-54', occupation: 'journalist' },
            { age: '55+', occupation: 'professor' }
        ];

        const topic = aiTopics[Math.floor(Math.random() * aiTopics.length)];
        const sentiment = sentiments[Math.floor(Math.random() * sentiments.length)];
        const location = locations[Math.floor(Math.random() * locations.length)];
        const demo = demographics[Math.floor(Math.random() * demographics.length)];
        
        return {
            id: 'mock_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
            platform: 'simulated_feed',
            content: 'Discussion about ' + topic + '. This represents ' + sentiment + ' sentiment in AI discourse.',
            timestamp: new Date().toISOString(),
            engagement_count: Math.floor(Math.random() * 1000),
            location: location,
            sentiment_indicator: sentiment,
            demographics: demo,
            ai_relevance_score: 0.95 + (Math.random() * 0.05)
        };
    }

    async collectRedditPosts(subreddit, limit) {
        subreddit = subreddit || 'artificial';
        limit = limit || 10;
        
        try {
            const url = 'https://www.reddit.com/r/' + subreddit + '/new.json?limit=' + limit;
            const response = await fetch(url, {
                headers: {
                    'User-Agent': 'PulseOfAI/1.0 (Educational Research Dashboard)'
                }
            });
            
            if (!response.ok) {
                console.log('Reddit API limit reached, using mock data...');
                return this.generateMockDataBatch(limit);
            }
            
            const data = await response.json();
            const posts = data.data.children.map(child => {
                const post = child.data;
                return {
                    id: 'reddit_' + post.id,
                    platform: 'reddit',
                    content: post.title + (post.selftext ? ' ' + post.selftext : ''),
                    timestamp: new Date(post.created_utc * 1000).toISOString(),
                    engagement_count: post.score + post.num_comments,
                    ai_relevance_score: this.calculateAIRelevance(post.title + ' ' + post.selftext),
                    url: 'https://reddit.com' + post.permalink
                };
            });
            
            console.log('Collected ' + posts.length + ' posts from r/' + subreddit);
            return posts;
            
        } catch (error) {
            console.log('Reddit collection failed, using mock data:', error.message);
            return this.generateMockDataBatch(limit);
        }
    }

    generateMockDataBatch(count) {
        count = count || 10;
        const posts = [];
        for (let i = 0; i < count; i++) {
            posts.push(this.generateMockAIPost());
        }
        console.log('Generated ' + count + ' mock AI discourse posts');
        return posts;
    }

    calculateAIRelevance(text) {
        const aiKeywords = [
            'artificial intelligence', 'machine learning', 'deep learning', 'neural network',
            'chatgpt', 'gpt', 'ai', 'automation', 'algorithm', 'robot', 'autonomous',
            'computer vision', 'natural language', 'llm', 'generative', 'openai'
        ];
        
        const lowerText = text.toLowerCase();
        let score = 0;
        
        aiKeywords.forEach(keyword => {
            if (lowerText.includes(keyword)) {
                score += 0.1;
            }
        });
        
        return Math.min(score, 1.0);
    }

    async savePosts(posts, filename) {
        filename = filename || 'latest_posts.json';
        const filepath = path.join(this.dataDir, filename);
        const timestamp = new Date().toISOString();
        
        const dataToSave = {
            collected_at: timestamp,
            posts: posts,
            count: posts.length
        };
        
        fs.writeFileSync(filepath, JSON.stringify(dataToSave, null, 2));
        console.log('Saved ' + posts.length + ' posts to ' + filename);
    }

    async collectData() {
        console.log('Starting data collection...');
        
        try {
            const posts = await this.collectRedditPosts('artificial', 15);
            await this.savePosts(posts);
            console.log('Data collection complete: ' + posts.length + ' posts');
            return posts;
            
        } catch (error) {
            console.error('Data collection failed:', error);
            return [];
        }
    }
}

module.exports = AIDiscourseCollector;
