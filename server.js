const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// Game state management
const gameRooms = new Map();
const playerSockets = new Map();

// Constants
const GAME_WIDTH = 1024;
const GAME_HEIGHT = 600;
const BASKET_X = GAME_WIDTH - 100;
const BASKET_Y = 150;
const CENTER_X = GAME_WIDTH / 2;
const CENTER_Y = GAME_HEIGHT / 2;
const PLAYER_SPEED = 5;
const BALL_SPEED = 7;
const BALL_RADIUS = 10;

// Game Room class
class GameRoom {
  constructor(roomId) {
    this.id = roomId;
    this.players = new Map();
    this.ball = {
      x: CENTER_X,
      y: CENTER_Y,
      vx: 0,
      vy: 0,
      owner: null,
      inBasket: false
    };
    this.score = { team1: 0, team2: 0 };
    this.gameState = 'waiting'; // waiting, playing, paused, ended
    this.lastUpdate = Date.now();
    this.gameStartTime = null;
    this.maxPlayers = 6;
  }

  addPlayer(playerId, playerData) {
    if (this.players.size >= this.maxPlayers) {
      return false;
    }

    const team = this.players.size < 3 ? 'team1' : 'team2';
    this.players.set(playerId, {
      id: playerId,
      name: playerData.name,
      team: team,
      x: team === 'team1' ? 100 : GAME_WIDTH - 100,
      y: CENTER_Y + (this.players.size % 3) * 80 - 80,
      vx: 0,
      vy: 0,
      hasBall: false,
      score: 0,
      active: true
    });

    return true;
  }

  removePlayer(playerId) {
    this.players.delete(playerId);
    if (this.ball.owner === playerId) {
      this.ball.owner = null;
    }
    return this.players.size === 0;
  }

  updatePlayerPosition(playerId, x, y, vx, vy) {
    const player = this.players.get(playerId);
    if (player) {
      player.x = Math.max(0, Math.min(GAME_WIDTH - 20, x));
      player.y = Math.max(0, Math.min(GAME_HEIGHT - 20, y));
      player.vx = vx;
      player.vy = vy;
    }
  }

  updateBall() {
    if (this.gameState !== 'playing') return;

    const timeDelta = (Date.now() - this.lastUpdate) / 1000;
    this.lastUpdate = Date.now();

    if (this.ball.owner) {
      const owner = this.players.get(this.ball.owner);
      if (owner) {
        this.ball.x = owner.x + 15;
        this.ball.y = owner.y + 15;
      }
    } else {
      // Apply physics to ball
      this.ball.x += this.ball.vx * timeDelta * BALL_SPEED;
      this.ball.y += this.ball.vy * timeDelta * BALL_SPEED;

      // Apply gravity and friction
      this.ball.vy += 5 * timeDelta; // gravity
      this.ball.vx *= 0.98; // friction
      this.ball.vy *= 0.98;

      // Ball collision with walls
      if (this.ball.x - BALL_RADIUS < 0) {
        this.ball.x = BALL_RADIUS;
        this.ball.vx = Math.abs(this.ball.vx);
      }
      if (this.ball.x + BALL_RADIUS > GAME_WIDTH) {
        this.ball.x = GAME_WIDTH - BALL_RADIUS;
        this.ball.vx = -Math.abs(this.ball.vx);
      }
      if (this.ball.y - BALL_RADIUS < 0) {
        this.ball.y = BALL_RADIUS;
        this.ball.vy = Math.abs(this.ball.vy);
      }
      if (this.ball.y + BALL_RADIUS > GAME_HEIGHT) {
        this.ball.y = GAME_HEIGHT - BALL_RADIUS;
        this.ball.vy = -Math.abs(this.ball.vy) * 0.7; // bounce
      }

      // Check basket collision (simplified)
      const distToBasket = Math.sqrt(
        Math.pow(this.ball.x - BASKET_X, 2) +
        Math.pow(this.ball.y - BASKET_Y, 2)
      );

      if (distToBasket < 30) {
        this.ball.inBasket = true;
        this.scorePoint(this.ball.owner);
        this.resetBall();
      }
    }

    // Check ball collision with players
    this.players.forEach((player) => {
      if (!this.ball.owner) {
        const distToPlayer = Math.sqrt(
          Math.pow(this.ball.x - player.x, 2) +
          Math.pow(this.ball.y - player.y, 2)
        );

        if (distToPlayer < 35) {
          this.ball.owner = player.id;
          player.hasBall = true;
        }
      }
    });
  }

  scorePoint(playerId) {
    if (!playerId) return;

    const player = this.players.get(playerId);
    if (player) {
      if (player.team === 'team1') {
        this.score.team1 += 2;
      } else {
        this.score.team2 += 2;
      }
      player.score += 2;
    }
  }

  resetBall() {
    this.ball = {
      x: CENTER_X,
      y: CENTER_Y,
      vx: 0,
      vy: 0,
      owner: null,
      inBasket: false
    };

    this.players.forEach(player => {
      player.hasBall = false;
    });
  }

  throwBall(direction, power) {
    if (this.ball.owner) {
      const owner = this.players.get(this.ball.owner);
      if (owner) {
        const angle = direction; // in radians
        const strength = Math.min(power, 100) / 100;

        this.ball.vx = Math.cos(angle) * strength;
        this.ball.vy = Math.sin(angle) * strength;
        this.ball.owner = null;
        owner.hasBall = false;
      }
    }
  }

  startGame() {
    if (this.players.size >= 2) {
      this.gameState = 'playing';
      this.gameStartTime = Date.now();
      this.lastUpdate = Date.now();
      return true;
    }
    return false;
  }

  getGameState() {
    return {
      roomId: this.id,
      players: Array.from(this.players.values()),
      ball: this.ball,
      score: this.score,
      gameState: this.gameState,
      gameStartTime: this.gameStartTime
    };
  }
}

// REST API Routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.get('/api/rooms', (req, res) => {
  const rooms = Array.from(gameRooms.values()).map(room => ({
    id: room.id,
    playerCount: room.players.size,
    maxPlayers: room.maxPlayers,
    gameState: room.gameState,
    score: room.score
  }));
  res.json(rooms);
});

app.post('/api/rooms', (req, res) => {
  const roomId = `room-${Date.now()}`;
  const room = new GameRoom(roomId);
  gameRooms.set(roomId, room);
  res.json({ roomId, message: 'Room created successfully' });
});

// Socket.IO Events
io.on('connection', (socket) => {
  console.log(`New player connected: ${socket.id}`);

  socket.on('join-room', (data, callback) => {
    const { roomId, playerName } = data;

    let room = gameRooms.get(roomId);
    if (!room) {
      room = new GameRoom(roomId);
      gameRooms.set(roomId, room);
    }

    const success = room.addPlayer(socket.id, { name: playerName });

    if (success) {
      socket.join(roomId);
      playerSockets.set(socket.id, { roomId, playerId: socket.id });

      // Notify all players in room
      io.to(roomId).emit('room-update', room.getGameState());
      callback({ success: true, gameState: room.getGameState() });
    } else {
      callback({ success: false, error: 'Room is full' });
    }
  });

  socket.on('player-move', (data) => {
    const playerData = playerSockets.get(socket.id);
    if (!playerData) return;

    const room = gameRooms.get(playerData.roomId);
    if (room) {
      room.updatePlayerPosition(
        socket.id,
        data.x,
        data.y,
        data.vx,
        data.vy
      );
      io.to(playerData.roomId).emit('room-update', room.getGameState());
    }
  });

  socket.on('throw-ball', (data) => {
    const playerData = playerSockets.get(socket.id);
    if (!playerData) return;

    const room = gameRooms.get(playerData.roomId);
    if (room) {
      room.throwBall(data.direction, data.power);
      io.to(playerData.roomId).emit('room-update', room.getGameState());
    }
  });

  socket.on('start-game', () => {
    const playerData = playerSockets.get(socket.id);
    if (!playerData) return;

    const room = gameRooms.get(playerData.roomId);
    if (room && room.startGame()) {
      io.to(playerData.roomId).emit('game-started', room.getGameState());
      startGameLoop(playerData.roomId);
    }
  });

  socket.on('pause-game', () => {
    const playerData = playerSockets.get(socket.id);
    if (!playerData) return;

    const room = gameRooms.get(playerData.roomId);
    if (room) {
      room.gameState = 'paused';
      io.to(playerData.roomId).emit('game-paused', room.getGameState());
    }
  });

  socket.on('resume-game', () => {
    const playerData = playerSockets.get(socket.id);
    if (!playerData) return;

    const room = gameRooms.get(playerData.roomId);
    if (room) {
      room.gameState = 'playing';
      io.to(playerData.roomId).emit('game-resumed', room.getGameState());
    }
  });

  socket.on('leave-room', () => {
    const playerData = playerSockets.get(socket.id);
    if (!playerData) return;

    const room = gameRooms.get(playerData.roomId);
    if (room) {
      const isEmpty = room.removePlayer(socket.id);
      socket.leave(playerData.roomId);

      if (isEmpty) {
        gameRooms.delete(playerData.roomId);
        io.to(playerData.roomId).emit('room-closed');
      } else {
        io.to(playerData.roomId).emit('room-update', room.getGameState());
      }
    }

    playerSockets.delete(socket.id);
  });

  socket.on('disconnect', () => {
    const playerData = playerSockets.get(socket.id);
    if (playerData) {
      const room = gameRooms.get(playerData.roomId);
      if (room) {
        const isEmpty = room.removePlayer(socket.id);
        if (isEmpty) {
          gameRooms.delete(playerData.roomId);
        } else {
          io.to(playerData.roomId).emit('room-update', room.getGameState());
        }
      }
      playerSockets.delete(socket.id);
    }
    console.log(`Player disconnected: ${socket.id}`);
  });

  socket.on('error', (error) => {
    console.error(`Socket error for ${socket.id}:`, error);
  });
});

// Game loop for physics updates
const gameLoops = new Map();

function startGameLoop(roomId) {
  if (gameLoops.has(roomId)) return; // Already running

  const loop = setInterval(() => {
    const room = gameRooms.get(roomId);

    if (!room || room.gameState !== 'playing') {
      clearInterval(loop);
      gameLoops.delete(roomId);
      return;
    }

    room.updateBall();
    io.to(roomId).emit('game-update', room.getGameState());
  }, 1000 / 60); // 60 FPS

  gameLoops.set(roomId, loop);
}

// Cleanup function for idle rooms
setInterval(() => {
  const now = Date.now();
  gameRooms.forEach((room, roomId) => {
    if (room.players.size === 0) {
      gameRooms.delete(roomId);
      if (gameLoops.has(roomId)) {
        clearInterval(gameLoops.get(roomId));
        gameLoops.delete(roomId);
      }
    }
  });
}, 60000); // Check every minute

// Error handling
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🏀 Basketball Game Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});

module.exports = { app, server, io };