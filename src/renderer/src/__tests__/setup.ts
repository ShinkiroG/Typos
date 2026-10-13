// o lib.ts lê window.api (preload) ao carregar: nos testes não tem Electron
;(window as unknown as { api: object }).api = {}
