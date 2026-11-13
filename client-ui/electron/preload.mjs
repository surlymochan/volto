const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("api", Object.freeze({}));
