// import { Socket } from 'socket.io';
// import { Injectable } from '@nestjs/common';

// @Injectable()
// export class SocketStateService {
//   private socketState = new Map<string, Socket[]>();

//   private activeUsers = new Map<string, boolean>();

//   public activeUser(userId: string, status: boolean) {
//     if (status) {
//       this.activeUsers.set(userId, status);
//     } else {
//       this.activeUsers.delete(userId);
//     }
//   }

//   public getStatus(userId: string) {
//     return this.activeUsers.get(userId);
//   }

//   public remove(userId: string, socket: Socket): boolean {
//     const existingSockets = this.socketState.get(userId);
//     if (!existingSockets) {
//       return true;
//     }
//     const sockets = existingSockets.filter((s) => s.id !== socket.id);
//     if (!sockets.length) {
//       this.socketState.delete(userId);
//     } else {
//       this.socketState.set(userId, sockets);
//     }
//     return true;
//   }

//   public add(userId: string, socket: Socket): boolean {
//     const existingSockets = this.socketState.get(userId) || [];
//     const sockets = [...existingSockets, socket];
//     this.socketState.set(userId, sockets);

//     return true;
//   }

//   public get(userId: string): Socket[] {
//     return this.socketState.get(userId) || [];
//   }

//   public getAll(): Socket[] {
//     const all = [];
//     this.socketState.forEach((sockets) => all.push(sockets));
//     return all;
//   }

//   public getAllFlat(): Socket[] {
//     const all = [];
//     this.socketState.forEach((sockets) =>
//       sockets.forEach((socket) => all.push(socket)),
//     );
//     return all;
//   }
// }
