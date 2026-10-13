import { contextBridge, ipcRenderer } from 'electron';
import { API_NAME, WIRE } from '../shared/channels.ts';
import { createApi } from './api.ts';

// The only thing the page is given. It runs with the page isolated (a context of its own), so the page cannot reach `ipcRenderer` or anything else here.
contextBridge.exposeInMainWorld(
  API_NAME,
  createApi({
    invoke: (wire, message) => ipcRenderer.invoke(wire, message),
    listen: (listener) => {
      const handler = (_event: unknown, payload: unknown): void => listener(payload);
      ipcRenderer.on(WIRE.event, handler);
      return () => void ipcRenderer.removeListener(WIRE.event, handler);
    },
  }),
);
