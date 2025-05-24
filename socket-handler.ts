
import type { Server as SocketIOServer, Socket } from 'socket.io';
import { 
  addPlayerToRoomStore, 
  startGameInRoomStore,
  claimPrizeStore,
  getRoomStateForClient,
  getRoomStore // For checking room existence before joining client to socket room
} from '@/lib/server/game-store';
import type { PrizeType, Room } from '@/types';

export function setupSocketListeners(io: SocketIOServer): void {
  io.on('connection', (socket: Socket) => {
    console.log(`Socket connected: ${socket.id}`);

    socket.on('joinRoom', async (data: { roomId: string; playerId: string; playerName: string; ticketsToBuy: number }) => {
      const { roomId, playerId, playerName, ticketsToBuy } = data;
      console.log(`Socket event "joinRoom": Player ${playerName} (${playerId}) attempting to join room ${roomId} with ${ticketsToBuy} tickets`);
      
      const roomExists = !!getRoomStore(roomId);
      if (!roomExists) {
        socket.emit('roomError', { message: `Room ${roomId} not found. Cannot join socket room.`});
        console.log(`Socket event "joinRoom": Room ${roomId} not found for player ${playerId}.`);
        return;
      }
      socket.join(roomId); // Join the socket.io room
      
      const result = addPlayerToRoomStore(roomId, { id: playerId, name: playerName }, ticketsToBuy);

      if (result && 'error' in result) {
        socket.emit('roomError', { message: result.error });
        console.log(`Socket event "joinRoom": Error for player ${playerId} in room ${roomId}: ${result.error}`);
      } else {
        const roomState = getRoomStateForClient(roomId);
        if (roomState) {
            io.to(roomId).emit('roomUpdate', roomState);
            console.log(`Socket event "joinRoom": Player ${playerName} (${playerId}) processed for room ${roomId}. Emitting roomUpdate.`);
        } else {
            socket.emit('roomError', { message: "Failed to get room state after join."});
            console.error(`Socket event "joinRoom": Failed to get room state for ${roomId} after player ${playerId} join.`);
        }
      }
    });

    socket.on('startGame', (data: { roomId: string; hostId: string }) => {
      const { roomId, hostId } = data;
      console.log(`Socket event "startGame": Host ${hostId} attempting to start game in room ${roomId}`);
      
      // startGameInRoomStore starts the server-side interval for number calling
      const result = startGameInRoomStore(roomId, hostId); 
      
      if (result && 'error' in result) {
        socket.emit('roomError', { message: result.error });
        console.log(`Socket event "startGame": Error starting game in room ${roomId}: ${result.error}`);
      } else {
        const roomState = getRoomStateForClient(roomId);
        if (roomState) {
            io.to(roomId).emit('gameStarted', roomState); // Specific event for game start
            io.to(roomId).emit('roomUpdate', roomState);  // General state update
            console.log(`Socket event "startGame": Game started in room ${roomId}. Emitting gameStarted and roomUpdate.`);
        } else {
             socket.emit('roomError', { message: "Failed to get room state after starting game."});
             console.error(`Socket event "startGame": Failed to get room state for ${roomId} after game start by ${hostId}.`);
        }
      }
    });

    socket.on('claimPrize', (data: { roomId: string; playerId: string; prizeType: PrizeType; ticketIndex: number }) => {
      const { roomId, playerId, prizeType, ticketIndex } = data;
      console.log(`Socket event "claimPrize": Player ${playerId} attempting to claim ${prizeType} in room ${roomId} on ticket index ${ticketIndex}`);
      
      const result = claimPrizeStore(roomId, playerId, prizeType, ticketIndex);
      
      if (result && 'error' in result) {
        socket.emit('roomError', { message: result.error, prizeType });
        console.log(`Socket event "claimPrize": Error for ${playerId} claiming ${prizeType} in room ${roomId}: ${result.error}`);
      } else {
        const roomState = getRoomStateForClient(roomId);
        if (roomState) {
            io.to(roomId).emit('roomUpdate', roomState);
            console.log(`Socket event "claimPrize": Processed for ${prizeType} by ${playerId} in room ${roomId}. Emitting roomUpdate.`);
            if (roomState.isGameOver) {
                io.to(roomId).emit('gameOver', roomState);
                console.log(`Socket event "claimPrize": Game over in room ${roomId} after claim by ${playerId}. Emitting gameOver.`);
            }
        } else {
             socket.emit('roomError', { message: "Failed to get room state after prize claim."});
             console.error(`Socket event "claimPrize": Failed to get room state for ${roomId} after prize claim by ${playerId}.`);
        }
      }
    });
    
    socket.on('requestInitialRoomState', (roomId: string) => {
      console.log(`Socket event "requestInitialRoomState": Socket ${socket.id} requesting state for room ${roomId}`);
      const room = getRoomStore(roomId); 
      if (room) {
          socket.join(roomId); 
          const roomState = getRoomStateForClient(roomId);
          if (roomState) {
              socket.emit('roomUpdate', roomState);
              console.log(`Socket event "requestInitialRoomState": Sent initial room state for ${roomId} to socket ${socket.id}`);
          } else {
              socket.emit('roomError', { message: `Could not retrieve state for room ${roomId}.` });
              console.error(`Socket event "requestInitialRoomState": Failed to get client state for existing room ${roomId} for socket ${socket.id}.`);
          }
      } else {
          socket.emit('roomError', { message: `Room ${roomId} not found.` });
          console.log(`Socket event "requestInitialRoomState": Room ${roomId} not found for socket ${socket.id}.`);
      }
    });

    socket.on('disconnect', () => {
      console.log(`Socket disconnected: ${socket.id}`);
      // TODO: Handle player leaving a room: remove from room.players, stop timer if host leaves and no one else, etc.
      // This requires mapping socket.id to playerId and roomId(s), which is not yet implemented.
    });
  });
}
