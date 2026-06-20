const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

// تخزين بيانات الغرف
const rooms = {};

function generateRoomId() {
    return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function createDeck() {
    const cards = [];
    const suits = ['♠️', '♥️', '♦️', '♣️'];
    for (let suit of suits) {
        for (let value = 2; value <= 14; value++) {
            let label = value;
            if (value === 11) label = 'J';
            if (value === 12) label = 'Q';
            if (value === 13) label = 'K';
            if (value === 14) label = 'A';
            cards.push({ suit, value, label });
        }
    }
    return cards.sort(() => Math.random() - 0.5);
}

io.on('connection', (socket) => {
    let currentRoomId = null;

    // 1. إنشاء غرفة جديدة
    socket.on('createRoom', () => {
        const roomId = generateRoomId();
        rooms[roomId] = {
            players: [{ id: socket.id, score: 0, hand: [], playedCard: null }],
            status: 'waiting',
            turn: 0
        };
        currentRoomId = roomId;
        socket.join(roomId);
        socket.emit('roomCreated', roomId);
    });

    // 2. الانضمام لغرفة قائمة
    socket.on('joinRoom', (roomId) => {
        roomId = roomId.toUpperCase();
        if (!rooms[roomId]) {
            return socket.emit('errorMsg', 'عذراً، هذه الغرفة غير موجودة!');
        }
        if (rooms[roomId].players.length >= 2) {
            return socket.emit('errorMsg', 'الغرفة ممتلئة بالفعل!');
        }

        rooms[roomId].players.push({ id: socket.id, score: 0, hand: [], playedCard: null });
        currentRoomId = roomId;
        socket.join(roomId);

        // بدء اللعبة تلقائياً عند اكتمال اللاعبين
        if (rooms[roomId].players.length === 2) {
            rooms[roomId].status = 'playing';
            const deck = createDeck();
            
            // توزيع 5 أوراق لكل لاعب
            rooms[roomId].players[0].hand = deck.slice(0, 5);
            rooms[roomId].players[1].hand = deck.slice(5, 10);
            rooms[roomId].turn = 0; // اللاعب الأول يبدأ

            io.to(roomId).emit('gameStarted', {
                roomId: roomId,
                turn: rooms[roomId].players[rooms[roomId].turn].id
            });
            sendGameState(roomId);
        }
    });

    // 3. عندما يلعب اللاعب ورقة
    socket.on('playCard', (cardIndex) => {
        const room = rooms[currentRoomId];
        if (!room || room.status !== 'playing') return;

        const playerIdx = room.players.findIndex(p => p.id === socket.id);
        if (playerIdx !== room.turn) return; // ليس دورك

        const player = room.players[playerIdx];
        player.playedCard = player.hand.splice(cardIndex, 1)[0];

        // تغيير الدور للاعب الآخر
        room.turn = room.turn === 0 ? 1 : 0;

        // إذا لعب كلا اللاعبين أوراقهما، نحسب الفائز بالجولة
        if (room.players[0].playedCard && room.players[1].playedCard) {
            const card0 = room.players[0].playedCard.value;
            const card1 = room.players[1].playedCard.value;
            let roundWinnerMessage = "";

            if (card0 > card1) {
                room.players[0].score++;
                roundWinnerMessage = "فاز اللاعب الأول بالجولة!";
            } else if (card1 > card0) {
                room.players[1].score++;
                roundWinnerMessage = "فاز اللاعب الثاني بالجولة!";
            } else {
                roundWinnerMessage = "تعادل في هذه الجولة!";
            }

            sendGameState(currentRoomId);
            io.to(currentRoomId).emit('roundResult', {
                msg: roundWinnerMessage,
                cards: [room.players[0].playedCard, room.players[1].playedCard]
            });

            // تنظيف الطاولة بعد ثانيتين والاستمرار أو إنهاء اللعبة
            setTimeout(() => {
                room.players[0].playedCard = null;
                room.players[1].playedCard = null;

                if (room.players[0].hand.length === 0) {
                    room.status = 'ended';
                    let finalWinner = "تعادل نهائي!";
                    if (room.players[0].score > room.players[1].score) finalWinner = "اللاعب الأول هو الفائز باللعبة! 🏆";
                    if (room.players[1].score > room.players[0].score) finalWinner = "اللاعب الثاني هو الفائز باللعبة! 🏆";
                    io.to(currentRoomId).emit('gameEnded', finalWinner);
                } else {
                    sendGameState(currentRoomId);
                    io.to(currentRoomId).emit('nextRound', room.players[room.turn].id);
                }
            }, 2500);

        } else {
            // لاعب واحد فقط لعب، نحدث الشاشة
            sendGameState(currentRoomId);
            io.to(currentRoomId).emit('nextRound', room.players[room.turn].id);
        }
    });

    // إرسال البيانات المخصصة لكل لاعب للحماية من الغش
    function sendGameState(roomId) {
        const room = rooms[roomId];
        if (!room) return;
        room.players.forEach((player, idx) => {
            const opponent = room.players[idx === 0 ? 1 : 0];
            io.to(player.id).emit('gameState', {
                myHand: player.hand,
                myScore: player.score,
                opponentScore: opponent ? opponent.score : 0,
                opponentCardCount: opponent ? opponent.hand.length : 0,
                myPlayed: player.playedCard,
                opponentPlayed: opponent && opponent.playedCard ? (room.players[0].playedCard && room.players[1].playedCard ? opponent.playedCard : {hidden: true}) : null
            });
        });
    }

    // عند خروج لاعب
    socket.on('disconnect', () => {
        if (currentRoomId && rooms[currentRoomId]) {
            io.to(currentRoomId).emit('errorMsg', 'خرج اللاعب الآخر.. انتهت اللعبة.');
            delete rooms[currentRoomId];
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
