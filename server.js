const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

// Serve the HTML file
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// Test mode toggle (set to false for production)
const TEST_MODE = true; // Keep false for production

// Force start endpoint for testing (remove for production)
if (TEST_MODE) {
    app.get('/force-start', (req, res) => {
        console.log('Force starting game for testing...');
        autoStartGame();
        res.send('Game started! Check the main page.');
    });
}

// Game numbering (days since launch)
const LAUNCH_DATE = new Date('2025-10-20'); // Change to your launch date

function getGameNumber() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const launch = new Date(LAUNCH_DATE);
    launch.setHours(0, 0, 0, 0);
    const daysSince = Math.floor((today - launch) / (1000 * 60 * 60 * 24));
    return daysSince + 1; // Game #1 on launch day
}

// Store today's questions
let dailyQuestions = {
    date: null,
    questions: []
};

// Store today's players and their results
let todayPlayers = {
    date: null,
    players: new Map() // persistentId -> { hasPlayed, result }
};

// Game state
let gameState = {
    status: 'waiting', // waiting, starting, playing, finished
    players: new Map(), // socketId -> player data
    currentQuestion: 0,
    questions: [],
    questionStartTime: null,
    timeLeft: 15,
    totalParticipants: 0,
    waitingCount: 0
};

// Load or create today's player data
function loadTodayPlayers() {
    const today = new Date().toDateString();
    const filename = 'today-players.json';
    
    // Reset if it's a new day
    if (todayPlayers.date !== today) {
        todayPlayers.date = today;
        todayPlayers.players = new Map();
        saveTodayPlayers();
        console.log('Reset player data for new day');
        return;
    }
    
    try {
        if (fs.existsSync(filename)) {
            const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
            if (data.date === today) {
                todayPlayers.date = data.date;
                todayPlayers.players = new Map(data.players);
                console.log(`Loaded ${todayPlayers.players.size} player records for today`);
            } else {
                // Different day in file, reset
                todayPlayers.date = today;
                todayPlayers.players = new Map();
                saveTodayPlayers();
                console.log('Reset player data for new day (file was old)');
            }
        }
    } catch (error) {
        console.error('Error loading today players:', error);
    }
}

// Save today's player data
function saveTodayPlayers() {
    try {
        const data = {
            date: todayPlayers.date,
            players: Array.from(todayPlayers.players.entries())
        };
        fs.writeFileSync('today-players.json', JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('Error saving today players:', error);
    }
}

// Setup robust daily scheduling with node-cron
function setupDailySchedule() {
    // Schedule game at 8:00 PM EST every day
    cron.schedule('0 0 20 * * *', async () => {
        console.log('Scheduled game time! Starting daily quiz...');
        await autoStartGame();
    }, {
        timezone: "America/New_York"
    });
    
    // Schedule daily reset at midnight EST
    cron.schedule('0 0 0 * * *', async () => {
        console.log('Midnight reset - clearing player data and fetching new questions');
        const today = new Date().toDateString();
        todayPlayers.date = today;
        todayPlayers.players.clear();
        saveTodayPlayers();
        await fetchDailyQuestions();
    }, {
        timezone: "America/New_York"
    });
    
    console.log('Daily schedules set up with node-cron - game at 8pm EST, reset at midnight EST');
}

// Auto-start the game at 8pm EST
async function autoStartGame() {
    // Don't start if game is already running
    if (gameState.status !== 'waiting') {
        console.log('Game already in progress, skipping auto-start');
        return;
    }
    
    // Count waiting players (those who haven't played today)
    const waitingPlayers = Array.from(gameState.players.values()).filter(p => {
        // Don't require persistentId - anyone connected who hasn't played can participate
        return !p.hasPlayedToday;
    });
    
    if (waitingPlayers.length === 0) {
        console.log('No players waiting for the game');
        return;
    }
    
    console.log(`Auto-starting game with ${waitingPlayers.length} waiting players`);
    
    // Mark all waiting players as ready
    waitingPlayers.forEach(player => {
        player.ready = true;
    });
    
    // Notify all clients that the game is starting
    io.emit('gameStarting');
    
    // Start the game
    await startGame();
}

// Fetch today's questions (called once per day)
async function fetchDailyQuestions() {
    const today = new Date().toDateString();
    
    // If we already have today's questions, use them
    if (dailyQuestions.date === today) {
        console.log('Using cached daily questions');
        return dailyQuestions.questions;
    }
    
    console.log('Fetching new daily questions from The Trivia API...');
    
    try {
        // Fetch 10 questions from The Trivia API
        // Using all categories for now, mixed difficulties
        const response = await axios.get('https://the-trivia-api.com/v2/questions', {
            params: {
                limit: 10,
                difficulties: 'easy,medium,hard',
                types: 'text_choice'
            }
        });
        
        if (!response.data || !Array.isArray(response.data)) {
            throw new Error('Invalid response from Trivia API');
        }
        
        // Sort by difficulty (easy → medium → hard)
        const sorted = response.data.sort((a, b) => {
            const order = { easy: 0, medium: 1, hard: 2 };
            return order[a.difficulty] - order[b.difficulty];
        });
        
        // Format questions to our structure
        dailyQuestions.questions = sorted.map((q, index) => {
            // Ensure proper difficulty distribution (3 easy, 3 medium, 4 hard)
            let difficulty = q.difficulty.toUpperCase();
            if (index < 3) difficulty = 'EASY';
            else if (index < 6) difficulty = 'MEDIUM';
            else difficulty = 'HARD';
            
            // The Trivia API provides incorrectAnswers array and correctAnswer separately
            const allAnswers = shuffleArray([
                q.correctAnswer,
                ...q.incorrectAnswers
            ]);
            
            return {
                question: q.question.text,
                correct: q.correctAnswer,
                answers: allAnswers,
                difficulty: difficulty,
                category: q.category
            };
        });
        
        dailyQuestions.date = today;
        
        // Save to file so questions persist if server restarts
        fs.writeFileSync('daily-questions.json', JSON.stringify(dailyQuestions, null, 2));
        
        console.log(`Fetched ${dailyQuestions.questions.length} questions for ${today}`);
        console.log('Categories included:', [...new Set(dailyQuestions.questions.map(q => q.category))]);
        return dailyQuestions.questions;
        
    } catch (error) {
        console.error('Error fetching daily questions from Trivia API:', error.message);
        
        // Try to load from file if API fails
        try {
            const saved = JSON.parse(fs.readFileSync('daily-questions.json', 'utf8'));
            dailyQuestions = saved;
            console.log('Loaded questions from backup file');
            return dailyQuestions.questions;
        } catch {
            console.error('No backup questions available, using emergency questions');
            return getEmergencyQuestions();
        }
    }
}

// Emergency questions (only if everything else fails)
function getEmergencyQuestions() {
    console.log('Using emergency questions');
    return [
        { question: "What color is the sky?", correct: "Blue", answers: ["Blue", "Green", "Red", "Yellow"], difficulty: "EASY", category: "General" },
        { question: "How many days in a week?", correct: "7", answers: ["5", "6", "7", "8"], difficulty: "EASY", category: "General" },
        { question: "What is 2 + 2?", correct: "4", answers: ["3", "4", "5", "6"], difficulty: "EASY", category: "Math" },
        { question: "Capital of France?", correct: "Paris", answers: ["Paris", "London", "Berlin", "Madrid"], difficulty: "MEDIUM", category: "Geography" },
        { question: "Who painted Mona Lisa?", correct: "Da Vinci", answers: ["Da Vinci", "Picasso", "Van Gogh", "Monet"], difficulty: "MEDIUM", category: "Art" },
        { question: "Year WW2 ended?", correct: "1945", answers: ["1943", "1944", "1945", "1946"], difficulty: "MEDIUM", category: "History" },
        { question: "Smallest prime number?", correct: "2", answers: ["1", "2", "3", "5"], difficulty: "HARD", category: "Math" },
        { question: "Element with atomic number 79?", correct: "Gold", answers: ["Silver", "Gold", "Platinum", "Mercury"], difficulty: "HARD", category: "Science" },
        { question: "Bones in adult human?", correct: "206", answers: ["206", "215", "195", "226"], difficulty: "HARD", category: "Science" },
        { question: "Capital of Kazakhstan?", correct: "Astana", answers: ["Almaty", "Astana", "Bishkek", "Tashkent"], difficulty: "HARD", category: "Geography" }
    ].map(q => ({ ...q, answers: shuffleArray(q.answers) }));
}

// On server start, load questions
async function initializeDailyQuestions() {
    try {
        const saved = JSON.parse(fs.readFileSync('daily-questions.json', 'utf8'));
        const today = new Date().toDateString();
        
        if (saved.date === today) {
            dailyQuestions = saved;
            console.log('Loaded today\'s questions from file');
            return;
        }
    } catch {
        // File doesn't exist or is invalid
    }
    
    // Fetch new questions
    await fetchDailyQuestions();
}

// Decode HTML entities (not needed for Trivia API but keeping for compatibility)
function decodeHTMLEntities(text) {
    const entities = {
        '&quot;': '"',
        '&apos;': "'",
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&#039;': "'",
        '&rsquo;': "'",
        '&lsquo;': "'",
        '&rdquo;': '"',
        '&ldquo;': '"',
        '&ndash;': '-',
        '&mdash;': '—',
        '&hellip;': '...',
        '&eacute;': 'é',
        '&Eacute;': 'É'
    };
    
    let result = text;
    for (let entity in entities) {
        result = result.replace(new RegExp(entity, 'g'), entities[entity]);
    }
    return result;
}

// Shuffle array
function shuffleArray(array) {
    const newArray = [...array];
    for (let i = newArray.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
    }
    return newArray;
}

// Handle new connections
io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);
    
    // Add player to game with temporary persistent ID
    gameState.players.set(socket.id, {
        id: socket.id,
        persistentId: null, // Will be set when client sends it
        name: 'Anonymous',
        alive: true,
        currentAnswer: null,
        correctAnswers: 0,
        hasPlayedToday: false,
        todayResult: null
    });
    
    // Handle persistent ID identification
    socket.on('identify', (persistentId) => {
        const player = gameState.players.get(socket.id);
        if (player) {
            player.persistentId = persistentId;
            
            // Check today's data to ensure it's for the current day
            const today = new Date().toDateString();
            if (todayPlayers.date !== today) {
                // Reset if it's a new day
                todayPlayers.date = today;
                todayPlayers.players.clear();
                saveTodayPlayers();
            }
            
            // Check if this player has played today
            const todayData = todayPlayers.players.get(persistentId);
            if (todayData) {
                player.hasPlayedToday = todayData.hasPlayed;
                player.todayResult = todayData.result;
            } else {
                player.hasPlayedToday = false;
                player.todayResult = null;
            }
            
            console.log(`Player ${socket.id} identified as ${persistentId}, played today: ${player.hasPlayedToday}`);
            
            // Update waiting count if they haven't played
            if (!player.hasPlayedToday && gameState.status === 'waiting') {
                gameState.waitingCount++;
                io.emit('waitingCount', gameState.waitingCount);
            }
        }
    });
    
    // Send game number immediately
    socket.emit('currentGameNumber', getGameNumber());
    
    // Handle game state request
    socket.on('getGameState', () => {
        const player = gameState.players.get(socket.id);
        // Count all players who haven't played today
        const waitingPlayers = Array.from(gameState.players.values()).filter(p => 
            !p.hasPlayedToday
        ).length;
        
        socket.emit('gameStateUpdate', {
            status: gameState.status,
            hasPlayedToday: player ? player.hasPlayedToday : false,
            todayResult: player ? player.todayResult : null,
            waitingPlayers: waitingPlayers,
            testMode: TEST_MODE
        });
    });
    
    // Handle test game request
    if (TEST_MODE) {
        socket.on('requestTestGame', () => {
            console.log('Test game requested by player');
            autoStartGame();
        });
    }
    
    // Broadcast waiting count if in waiting state, otherwise broadcast remaining players
    if (gameState.status === 'waiting') {
        // Count all players who haven't played today (even without persistentId)
        const waitingCount = Array.from(gameState.players.values()).filter(p => 
            !p.hasPlayedToday
        ).length;
        io.emit('playerCount', waitingCount);
    } else if (gameState.status === 'playing' || gameState.status === 'starting') {
        const remainingCount = Array.from(gameState.players.values()).filter(p => 
            p.alive && !p.leftGame && p.participatedInGame
        ).length;
        io.emit('playersRemaining', remainingCount);
    }
    
    // Handle disconnect
    socket.on('disconnect', () => {
        const player = gameState.players.get(socket.id);
        if (player && !player.hasPlayedToday && gameState.status === 'waiting') {
            gameState.waitingCount = Math.max(0, gameState.waitingCount - 1);
            io.emit('waitingCount', gameState.waitingCount);
        }
        gameState.players.delete(socket.id);
        
        // Update count based on game status
        if (gameState.status === 'waiting') {
            // Count all players who haven't played today
            const waitingCount = Array.from(gameState.players.values()).filter(p => 
                !p.hasPlayedToday
            ).length;
            io.emit('playerCount', waitingCount);
        } else if (gameState.status === 'playing' || gameState.status === 'starting') {
            const remainingCount = Array.from(gameState.players.values()).filter(p => 
                p.alive && !p.leftGame && p.participatedInGame
            ).length;
            io.emit('playersRemaining', remainingCount);
        }
        
        console.log('Player disconnected:', socket.id);
    });
    
    // Handle leave game (spectator returning to lobby)
    socket.on('leaveGame', () => {
        const player = gameState.players.get(socket.id);
        if (player) {
            player.ready = false;
            player.alive = false;
            player.leftGame = true;
            console.log(`Player ${socket.id} left the game and returned to lobby`);
        }
    });
    
    // Handle answers
    socket.on('submitAnswer', (answerIndex) => {
        const player = gameState.players.get(socket.id);
        if (player && player.alive && gameState.status === 'playing' && !player.leftGame) {
            player.currentAnswer = answerIndex;
        }
    });
});

// Start the game
async function startGame() {
    console.log('Starting game with', gameState.players.size, 'players');
    gameState.status = 'starting';
    gameState.waitingCount = 0;
    
    // Use today's questions
    gameState.questions = await fetchDailyQuestions();
    gameState.currentQuestion = 0;
    
    // Track total participants at game start
    gameState.totalParticipants = 0;
    
    // Reset all players who are connected and haven't played today
    // Don't require persistentId for participation - they just won't have their result saved
    gameState.players.forEach(player => {
        if (!player.hasPlayedToday && !player.leftGame) {
            player.alive = true;
            player.correctAnswers = 0;
            player.currentAnswer = null;
            player.participatedInGame = true;
            player.hasPlayedToday = true;
            gameState.totalParticipants++;
        }
    });
    
    console.log(`Game starting with ${gameState.totalParticipants} total participants`);
    
    // Countdown
    for (let i = 3; i > 0; i--) {
        io.emit('countdown', i);
        await sleep(1000);
    }
    
    gameState.status = 'playing';
    
    // Broadcast initial remaining count
    const remainingCount = Array.from(gameState.players.values()).filter(p => 
        p.alive && !p.leftGame && p.participatedInGame
    ).length;
    io.emit('playersRemaining', remainingCount);
    
    nextQuestion();
}

// Show next question
function nextQuestion() {
    if (gameState.currentQuestion >= gameState.questions.length) {
        endGame();
        return;
    }
    
    const question = gameState.questions[gameState.currentQuestion];
    
    // Reset answers
    gameState.players.forEach(p => p.currentAnswer = null);
    
    // Send question to all players (active and spectating)
    gameState.players.forEach((player, socketId) => {
        if (!player.leftGame) {
            io.to(socketId).emit('question', {
                number: gameState.currentQuestion + 1,
                total: gameState.questions.length,
                question: question.question,
                answers: question.answers,
                difficulty: question.difficulty,
                category: question.category,
                timeLimit: 15
            });
        }
    });
    
    gameState.questionStartTime = Date.now();
    
    // Start timer
    let timeLeft = 15;
    const timer = setInterval(() => {
        timeLeft--;
        gameState.players.forEach((player, socketId) => {
            if (!player.leftGame) {
                io.to(socketId).emit('timer', timeLeft);
            }
        });
        
        if (timeLeft <= 0) {
            clearInterval(timer);
            processAnswers();
        }
    }, 1000);
}

// Process answers and eliminate players
function processAnswers() {
    const question = gameState.questions[gameState.currentQuestion];
    const correctIndex = question.answers.indexOf(question.correct);
    
    let eliminated = [];
    let survivors = [];
    
    gameState.players.forEach(player => {
        if (player.alive && !player.leftGame && player.participatedInGame) {
            if (player.currentAnswer === correctIndex) {
                player.correctAnswers++;
                survivors.push(player.id);
            } else {
                player.alive = false;
                eliminated.push(player.id);
                
                // Save their result if they have a persistent ID
                if (player.persistentId) {
                    const result = {
                        hasPlayed: true,
                        result: {
                            position: survivors.length + eliminated.length,
                            totalPlayers: gameState.totalParticipants,
                            questionsCorrect: player.correctAnswers,
                            gameNumber: getGameNumber()
                        }
                    };
                    
                    todayPlayers.players.set(player.persistentId, result);
                    player.hasPlayedToday = true;
                    player.todayResult = result.result;
                    saveTodayPlayers();
                }
            }
        }
    });
    
    const alivePlayers = Array.from(gameState.players.values()).filter(p => 
        p.alive && !p.leftGame && p.participatedInGame
    );
    
    // Send results to all players
    gameState.players.forEach((player, socketId) => {
        if (!player.leftGame) {
            io.to(socketId).emit('results', {
                correct: question.correct,
                correctIndex: correctIndex,
                eliminated: eliminated.length,
                remaining: alivePlayers.length,
                totalPlayers: gameState.totalParticipants
            });
        }
    });
    
    // Update remaining player count
    io.emit('playersRemaining', alivePlayers.length);
    
    // Tell eliminated players
    eliminated.forEach(playerId => {
        const player = gameState.players.get(playerId);
        if (player && !player.leftGame) {
            io.to(playerId).emit('eliminated', {
                position: alivePlayers.length + 1,
                totalPlayers: gameState.totalParticipants,
                questionsCorrect: player.correctAnswers,
                gameNumber: getGameNumber()
            });
        }
    });
    
    // Check if game should end
    if (gameState.currentQuestion >= 9 || alivePlayers.length <= 1) {
        console.log(`Game ending - Question: ${gameState.currentQuestion + 1}/10, Players remaining: ${alivePlayers.length}`);
        setTimeout(() => endGame(), 5000);
    } else {
        gameState.currentQuestion++;
        setTimeout(() => nextQuestion(), 5000);
    }
}

// End game
function endGame() {
    console.log('Game ending...');
    gameState.status = 'finished';
    
    const winners = Array.from(gameState.players.values())
        .filter(p => p.alive && !p.leftGame && p.participatedInGame)
        .map(p => {
            // Save winner's result if they have a persistent ID
            if (p.persistentId) {
                const result = {
                    hasPlayed: true,
                    result: {
                        position: 1,
                        totalPlayers: gameState.totalParticipants,
                        questionsCorrect: p.correctAnswers,
                        gameNumber: getGameNumber()
                    }
                };
                
                todayPlayers.players.set(p.persistentId, result);
                p.hasPlayedToday = true;
                p.todayResult = result.result;
                saveTodayPlayers();
            }
            
            return { id: p.id, name: p.name, correct: p.correctAnswers };
        });
    
    console.log('Winners found:', winners.length);
    
    const participatingPlayers = Array.from(gameState.players.values())
        .filter(p => p.participatedInGame);
    
    const leaderboard = participatingPlayers
        .sort((a, b) => {
            if (b.correctAnswers !== a.correctAnswers) {
                return b.correctAnswers - a.correctAnswers;
            }
            return (b.alive ? 1 : 0) - (a.alive ? 1 : 0);
        })
        .slice(0, 10)
        .map((p, i) => ({
            position: i + 1,
            name: p.name,
            correct: p.correctAnswers,
            alive: p.alive
        }));
    
    const gameOverData = {
        winners: winners,
        leaderboard: leaderboard,
        gameNumber: getGameNumber(),
        totalParticipants: gameState.totalParticipants,
        finalQuestion: gameState.currentQuestion + 1
    };
    
    // Send game over to all players
    gameState.players.forEach((player, socketId) => {
        if (!player.leftGame) {
            io.to(socketId).emit('gameOver', gameOverData);
        }
    });
    
    // Wait a bit then reset for next day
    setTimeout(() => {
        resetGame();
    }, 30000); // Reset after 30 seconds
}

// Reset game
function resetGame() {
    gameState.status = 'waiting';
    gameState.currentQuestion = 0;
    gameState.totalParticipants = 0;
    
    gameState.players.forEach(player => {
        player.ready = false;
        player.alive = true;
        player.correctAnswers = 0;
        player.participatedInGame = false;
        // Don't reset hasPlayedToday or todayResult - they persist
    });
    
    // Recalculate and broadcast waiting count (all players who haven't played today)
    gameState.waitingCount = Array.from(gameState.players.values()).filter(p => 
        !p.hasPlayedToday
    ).length;
    
    io.emit('waitingCount', gameState.waitingCount);
    io.emit('playerCount', gameState.waitingCount); // Show waiting count in lobby
    
    console.log('Game has been reset');
}

// Helper sleep function
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Start server
const PORT = process.env.PORT || 3000;
http.listen(PORT, async () => {
    console.log(`Game running at http://localhost:${PORT}`);
    console.log(`Today is Quiz Royale #${getGameNumber()}`);
    console.log(`Test mode: ${TEST_MODE ? 'ENABLED' : 'DISABLED'}`);
    
    if (TEST_MODE) {
        console.log('Test endpoints available:');
        console.log(`  - Force start: http://localhost:${PORT}/force-start`);
        console.log('  - Or use the "Start Test Game" button in the UI');
    }
    
    // Load today's questions and players on startup
    await initializeDailyQuestions();
    loadTodayPlayers();
    
    // Setup robust daily scheduling with node-cron
    setupDailySchedule();
});











