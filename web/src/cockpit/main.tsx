import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { TooltipProvider } from '@/components/ui/tooltip'
import '@/index.css'
import { followSystemTheme } from '@/lib/theme'
import { Cockpit } from './Cockpit'

followSystemTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TooltipProvider>
      <Cockpit />
    </TooltipProvider>
  </StrictMode>
)
