
import type { Room, Player, GameSettings, BackendPlayerInRoom, PrizeType, PrizeClaim, HousieTicketGrid } from '@/types';
import { PRIZE_TYPES } from '@/types';
import { generateImprovedHousieTicket } from '@/lib/housie';
import { NUMBERS_RANGE_MIN, NUMBERS_RANGE_MAX, DEFAULT_GAME_SETTINGS, MIN_LOBBY_SIZE, PRIZE_DEFINITIONS, DEFAULT_NUMBER_OF_TICKETS_PER_PLAYER } from '@/lib/constants';
import { getIoInstance } from '@/lib/socket-instance';

declare global {
  // eslint-disable-next-line no-var
  var housieRooms: Map<string, Room>;
  // eslint-disable-next-line no-var
  var roomCallTimers: Map<string, NodeJS.Timeout>; // Changed name for clarity
}

const rooms = global.housieRooms || (global.housieRooms = new Map<string, Room>());
const roomCallTimers = global.roomCallTimers || (global.roomCallTimers = new Map<string, NodeJS.Timeout>());

const SERVER_CALL_INTERVAL = 5000; // 5 seconds for number calling

function generateRoomId(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function initializeNumberPool(): number[] {
  const pool = Array.from({ length: NUMBERS_RANGE_MAX - NUMBERS_RANGE_MIN + 1 }, (_, i) => NUMBERS_RANGE_MIN + i);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}

function initializePrizeStatus(roomSettings: GameSettings): Record<PrizeType, PrizeClaim | null> {
  const status: Record<PrizeType, PrizeClaim | null> = {} as Record<PrizeType, PrizeClaim | null>;
  const prizeFormat = roomSettings.prizeFormat || DEFAULT_GAME_SETTINGS.prizeFormat;
  const prizesForFormat = PRIZE_DEFINITIONS[prizeFormat] || Object.values(PRIZE_TYPES);

  (prizesForFormat as PrizeType[]).forEach(prize => {
    status[prize] = null;
  });
  return status;
}

function stopRoomCallingTimer(roomId: string, reason: string) {
  const timerId = roomCallTimers.get(roomId);
  if (timerId) {
    clearInterval(timerId);
    roomCallTimers.delete(roomId);
    console.log(`Room ${roomId}: Server-side auto-calling STOPPED. Reason: ${reason}`);
  }
}

export function createRoomStore(host: Player, clientSettings?: Partial<GameSettings>): Room {
  const roomId = generateRoomId();
  const gameSettings: GameSettings = { ...DEFAULT_GAME_SETTINGS, ...clientSettings };

  const hostPlayerInRoom: BackendPlayerInRoom = {
    ...host,
    isHost: true,
    tickets: [], // Host will "buy" tickets in the lobby
  };

  const newRoom: Room = {
    id: roomId,
    host: { id: host.id, name: host.name, isHost: true },
    players: [hostPlayerInRoom],
    settings: gameSettings,
    createdAt: new Date(),
    isGameStarted: false,
    isGameOver: false,
    currentNumber: null,
    calledNumbers: [],
    numberPool: initializeNumberPool(),
    prizeStatus: initializePrizeStatus(gameSettings),
    lastNumberCalledTimestamp: undefined,
  };
  rooms.set(roomId, newRoom);
  console.log(`Room created: ${roomId} by host ${host.id}. Settings: ${JSON.stringify(gameSettings)}`);
  return newRoom;
}

export function getRoomStore(roomId: string): Room | undefined {
  const room = rooms.get(roomId);
  if (room && !room.isGameStarted && (new Date().getTime() - new Date(room.createdAt).getTime()) > 24 * 60 * 60 * 1000) {
    stopRoomCallingTimer(roomId, "Room expired due to prolonged inactivity before start.");
    rooms.delete(roomId);
    console.log(`Room ${roomId} expired and deleted due to inactivity.`);
    return undefined;
  }
  return room;
}

export function addPlayerToRoomStore(roomId: string, playerInfo: { id: string; name: string }, ticketsToBuyRequest?: number): Room | { error: string } {
  const room = rooms.get(roomId);
  if (!room) return { error: "Room not found." };

  const numTicketsToGenerate = Math.max(1, ticketsToBuyRequest === undefined ? (room.settings.numberOfTicketsPerPlayer || DEFAULT_NUMBER_OF_TICKETS_PER_PLAYER) : ticketsToBuyRequest);

  const existingPlayerIndex = room.players.findIndex(p => p.id === playerInfo.id);

  if (existingPlayerIndex !== -1) {
    const existingPlayer = room.players[existingPlayerIndex];
    if (existingPlayer.tickets.length === 0 && numTicketsToGenerate > 0 && !room.isGameStarted) {
      existingPlayer.tickets = Array.from({ length: numTicketsToGenerate }, () => generateImprovedHousieTicket());
      console.log(`Player ${playerInfo.id} (existing) confirmed/bought ${numTicketsToGenerate} tickets in room ${roomId}.`);
    } else if (room.isGameStarted && existingPlayer.tickets.length === 0) {
      return { error: "Game has already started. Cannot add tickets now for this existing player." };
    } else if (existingPlayer.tickets.length > 0) {
       console.log(`Player ${playerInfo.id} already has tickets in room ${roomId}. No changes to tickets made.`);
    }
  } else {
    if (room.isGameStarted) return { error: "Game has already started. New players cannot join with tickets." };
    if (room.players.length >= room.settings.lobbySize) return { error: "Room is full." };
    
    const newPlayer: BackendPlayerInRoom = {
      id: playerInfo.id,
      name: playerInfo.name,
      isHost: playerInfo.id === room.host.id,
      tickets: Array.from({ length: numTicketsToGenerate }, () => generateImprovedHousieTicket()),
    };
    room.players.push(newPlayer);
    console.log(`New player ${playerInfo.name} (${playerInfo.id}) joined room ${roomId} with ${numTicketsToGenerate} tickets.`);
  }

  rooms.set(roomId, room);
  return room;
}

export function startGameInRoomStore(roomId: string, hostId: string): Room | { error: string } {
  const room = rooms.get(roomId);
  if (!room) return { error: "Room not found." };
  if (room.host.id !== hostId) return { error: "Only the host can start the game." };
  if (room.isGameStarted) return { error: "Game has already started." };

  const hostPlayer = room.players.find(p => p.id === hostId && p.isHost);
  if (!hostPlayer || (hostPlayer.tickets?.length || 0) === 0) {
    return { error: `Host must have tickets before starting the game.` };
  }

  const minPlayersRequired = process.env.NODE_ENV === 'development' ? 1 : MIN_LOBBY_SIZE;
  const playersWithTicketsCount = room.players.filter(p => (p.tickets?.length || 0) > 0).length;

  if (playersWithTicketsCount < minPlayersRequired) {
    return { error: `Need at least ${minPlayersRequired} player(s) with tickets to start. Currently: ${playersWithTicketsCount}` };
  }

  room.isGameStarted = true;
  room.isGameOver = false;
  room.numberPool = initializeNumberPool();
  room.calledNumbers = [];
  room.currentNumber = null;
  room.prizeStatus = initializePrizeStatus(room.settings);
  room.lastNumberCalledTimestamp = undefined;
  
  stopRoomCallingTimer(roomId, "Game is (re)starting."); // Clear any old timer

  const io = getIoInstance();
  if (!io) {
    console.error(`Socket.IO instance not available in startGameInRoomStore for room ${roomId}. Server-side auto-calling will not start.`);
  } else {
    console.log(`Room ${roomId}: Starting server-side auto-calling every ${SERVER_CALL_INTERVAL}ms.`);
    const intervalId = setInterval(() => {
      const currentRoomForInterval = getRoomStore(roomId); // Get fresh state
      if (!currentRoomForInterval || !currentRoomForInterval.isGameStarted || currentRoomForInterval.isGameOver) {
        stopRoomCallingTimer(roomId, !currentRoomForInterval ? "Room no longer exists (timer check)" : "Game not started or already over (timer check)");
        return;
      }
      
      const result = callNextNumberStore(roomId); // This updates the room in the `rooms` Map
      const roomStateForClient = getRoomStateForClient(roomId); 

      if (!roomStateForClient) {
        console.error(`Room ${roomId}: Failed to get client state after auto-call for interval, cannot emit.`);
        stopRoomCallingTimer(roomId, "Failed to retrieve client state during auto-call.");
        return;
      }

      io.to(roomId).emit('roomUpdate', roomStateForClient); // Emit updated state
      // console.log(`Room ${roomId}: Server auto-called. Emitted roomUpdate. Current#: ${roomStateForClient.currentNumber}`);

      if (roomStateForClient.isGameOver) { 
          io.to(roomId).emit('gameOver', roomStateForClient);
          stopRoomCallingTimer(roomId, "Game over condition met after successful auto-call.");
      }
    }, SERVER_CALL_INTERVAL);
    roomCallTimers.set(roomId, intervalId);
  }

  rooms.set(roomId, room);
  console.log(`Game started in room: ${roomId}. Server timer initiated.`);
  return room;
}

export function callNextNumberStore(roomId: string): Room | { error: string; number?: number } {
  const room = rooms.get(roomId);
  if (!room) return { error: "Room not found." };
  if (!room.isGameStarted) return { error: "Game not started." };
  if (room.isGameOver) {
    stopRoomCallingTimer(roomId, "Attempted to call number but game is already over.");
    return { error: "Game is over.", number: room.currentNumber };
  }

  if (room.numberPool.length === 0) {
    room.isGameOver = true;
    room.lastNumberCalledTimestamp = new Date();
    if (!room.prizeStatus[PRIZE_TYPES.FULL_HOUSE] || room.prizeStatus[PRIZE_TYPES.FULL_HOUSE]!.claimedBy.length === 0) {
      console.log(`Room ${roomId}: All numbers called. No Full House winner declared. Game Over.`);
    }
    rooms.set(roomId, room);
    stopRoomCallingTimer(roomId, "All numbers have been called.");
    return room;
  }

  const nextNumber = room.numberPool.pop();
  if (nextNumber === undefined) {
    room.isGameOver = true;
    room.lastNumberCalledTimestamp = new Date();
    rooms.set(roomId, room);
    stopRoomCallingTimer(roomId, "Number pool was unexpectedly empty.");
    return room;
  }

  room.currentNumber = nextNumber;
  room.calledNumbers.push(nextNumber);
  room.lastNumberCalledTimestamp = new Date();
  rooms.set(roomId, room);
  // console.log(`Room ${roomId}: Called number ${nextNumber}. Remaining in pool: ${room.numberPool.length}`);
  return room;
}

export function claimPrizeStore(
  roomId: string,
  playerId: string,
  prizeType: PrizeType,
  ticketIndex: number
): Room | { error: string } {
  const room = rooms.get(roomId);
  if (!room) return { error: "Room not found." };
  if (!room.isGameStarted) return { error: "Game not started." };

  const player = room.players.find(p => p.id === playerId);
  if (!player) return { error: "Player not found in this room." };
  if (ticketIndex < 0 || ticketIndex >= player.tickets.length) return { error: "Invalid ticket index." };
  
  const ticket = player.tickets[ticketIndex];

  if (room.isGameOver && prizeType !== PRIZE_TYPES.FULL_HOUSE) {
    return { error: "Game is over. No more claims except potentially Full House." };
  }
  if (room.prizeStatus[prizeType]?.claimedBy.includes(playerId)) {
    return { error: `You have already claimed ${prizeType}.` };
  }
  
  const isFullHouseAlreadyClaimedByAnyone = room.prizeStatus[PRIZE_TYPES.FULL_HOUSE]?.claimedBy.length > 0;
  if (isFullHouseAlreadyClaimedByAnyone && prizeType !== PRIZE_TYPES.FULL_HOUSE) {
      return { error: "Full House already claimed by someone, no more claims for other prizes." };
  }

  const housieLib = require('@/lib/housie'); 
  const isValidClaim = housieLib.checkWinningCondition(ticket, room.calledNumbers, prizeType);

  if (!isValidClaim) return { error: `Claim for ${prizeType} on ticket ${ticketIndex + 1} is not valid (Bogey!). Ensure all numbers for the claim are marked and have been called.` };

  if (!room.prizeStatus[prizeType] || !Array.isArray(room.prizeStatus[prizeType]?.claimedBy)) {
    room.prizeStatus[prizeType] = { claimedBy: [], timestamp: new Date() };
  } else if (!room.prizeStatus[prizeType]!.timestamp) { 
    room.prizeStatus[prizeType]!.timestamp = new Date();
  }
  room.prizeStatus[prizeType]!.claimedBy.push(playerId);
  console.log(`Room ${roomId}: Player ${playerId} successfully claimed ${prizeType}.`);

  if (prizeType === PRIZE_TYPES.FULL_HOUSE) {
    room.isGameOver = true;
    console.log(`Room ${roomId}: Full House claimed by ${playerId}. Game Over.`);
    stopRoomCallingTimer(roomId, "Full House claimed.");

    const linePrizesToAutoCheck: PrizeType[] = [PRIZE_TYPES.TOP_LINE, PRIZE_TYPES.MIDDLE_LINE, PRIZE_TYPES.BOTTOM_LINE];
    for (const linePrize of linePrizesToAutoCheck) {
      const linePrizeClaim = room.prizeStatus[linePrize];
      if ((!linePrizeClaim || linePrizeClaim.claimedBy.length === 0 || !linePrizeClaim.claimedBy.includes(playerId)) &&
          housieLib.checkWinningCondition(ticket, room.calledNumbers, linePrize)) {
        
        if (!room.prizeStatus[linePrize] || !Array.isArray(room.prizeStatus[linePrize]?.claimedBy)) {
            room.prizeStatus[linePrize] = { claimedBy: [], timestamp: new Date() };
        }
        if (!room.prizeStatus[linePrize]!.claimedBy.includes(playerId)) { 
            room.prizeStatus[linePrize]!.claimedBy.push(playerId);
            console.log(`Room ${roomId}: Player ${playerId} auto-awarded ${linePrize} with Full House.`);
        }
      }
    }
  }
  rooms.set(roomId, room);
  return room;
}

export function getRoomStateForClient(roomId: string): Omit<Room, 'numberPool'> | undefined {
  const room = getRoomStore(roomId);
  if (!room) {
    return undefined;
  }

  try {
    const playersForClient = room.players.map(p => ({
      id: p.id,
      name: p.name,
      isHost: p.isHost,
      tickets: Array.isArray(p.tickets) ? p.tickets : [], 
    }));

    const prizeStatusForClient: Record<PrizeType, PrizeClaim | null> = {} as any;
    const currentPrizeFormat = room.settings?.prizeFormat || DEFAULT_GAME_SETTINGS.prizeFormat;
    const prizesToConsider = PRIZE_DEFINITIONS[currentPrizeFormat] || Object.values(PRIZE_TYPES);

    prizesToConsider.forEach(prizeKey => {
      const prize = prizeKey as PrizeType;
      const claim = room.prizeStatus[prize];
      if (claim) {
        prizeStatusForClient[prize] = {
          claimedBy: claim.claimedBy,
          timestamp: claim.timestamp ? (typeof claim.timestamp === 'string' ? claim.timestamp : new Date(claim.timestamp).toISOString()) : undefined,
        };
      } else {
        prizeStatusForClient[prize] = null;
      }
    });
    
    const clientRoomData = {
      id: room.id,
      host: room.host,
      players: playersForClient,
      settings: room.settings,
      createdAt: typeof room.createdAt === 'string' ? room.createdAt : new Date(room.createdAt).toISOString(),
      isGameStarted: room.isGameStarted,
      isGameOver: room.isGameOver,
      currentNumber: room.currentNumber,
      calledNumbers: room.calledNumbers,
      prizeStatus: prizeStatusForClient,
      lastNumberCalledTimestamp: room.lastNumberCalledTimestamp ? (typeof room.lastNumberCalledTimestamp === 'string' ? room.lastNumberCalledTimestamp : new Date(room.lastNumberCalledTimestamp).toISOString()) : undefined,
    };
    return clientRoomData;

  } catch (e) {
    console.error(`Error preparing room data for client for room ${roomId}:`, e);
    return undefined;
  }
}
