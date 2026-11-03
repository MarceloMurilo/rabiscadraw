import { createRoot } from 'react-dom/client'
import App from './App'
import '@fontsource/patrick-hand'
import '@fontsource/nunito/600.css'
import './styles.css'

// the chosen theme is applied before the first paint, so the page never flashes light when dark was picked
try { document.documentElement.dataset.theme = localStorage.getItem('rabiscadraw:theme') === 'dark' ? 'dark' : 'light' } catch { document.documentElement.dataset.theme = 'light' }

createRoot(document.getElementById('root')!).render(<App />)
