import { Server } from "socket.io";

let io;

export const initSocket = (httpServer, clientUrl) => {
  io = new Server(httpServer, { cors: { origin: clientUrl, credentials: true } });
  io.on("connection", (socket) => {
    console.log("Socket connected:", socket.id);
    socket.on("disconnect", () => console.log("Socket disconnected:", socket.id));
  });
  return io;
};

export const getIO = () => io;
