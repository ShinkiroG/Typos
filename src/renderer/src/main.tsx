import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import './timeline.css'
import './features.css'
import './montage/montage.css'
import './style/studio.css'
import './hud.css'

// erros da tela entram no relatório de erro (Ajuda → Gerar relatório de erro)
window.addEventListener('error', (e) => window.api.logError(`${e.message} (${e.filename}:${e.lineno})`))
window.addEventListener('unhandledrejection', (e) => window.api.logError('promessa: ' + String(e.reason?.stack ?? e.reason)))

createRoot(document.getElementById('root')!).render(<App />)
