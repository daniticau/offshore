import React, { useEffect, useRef, useState } from 'react'
import type { Suggestion } from '@shared/types'
import {
  IconClock,
  IconGlobe,
  IconSearch,
  IconStarFilled,
  IconWave
} from './icons'

interface PaletteProps {
  seed: string
  onClose: () => void
  onNavigate: (input: string) => void
  suggest: (q: string) => Promise<Suggestion[]>
}

const KIND_ICON: Record<Suggestion['kind'], React.ComponentType<{ size?: number }>> = {
  url: IconGlobe,
  search: IconSearch,
  history: IconClock,
  bookmark: IconStarFilled,
  internal: IconWave
}

export function Palette({ seed, onClose, onNavigate, suggest }: PaletteProps): React.JSX.Element {
  const [text, setText] = useState(seed)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => {
      if (!text.trim()) {
        setSuggestions([])
        setSelected(0)
        return
      }
      void suggest(text).then((s) => {
        setSuggestions(s)
        setSelected(0)
      })
    }, 70)
    return () => {
      if (debounce.current) clearTimeout(debounce.current)
    }
  }, [text, suggest])

  const submit = (value?: string): void => {
    const chosen = value ?? (suggestions[selected]?.url || text)
    if (!chosen.trim()) {
      onClose()
      return
    }
    // If a suggestion is selected, navigate to its URL; otherwise let main resolve raw text
    onNavigate(chosen)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((s) => Math.min(s + 1, Math.max(suggestions.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((s) => Math.max(s - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (suggestions.length && selected < suggestions.length) submit(suggestions[selected].url)
      else submit(text)
    }
  }

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-input-row">
          <IconSearch size={18} />
          <input
            ref={inputRef}
            value={text}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        {suggestions.length > 0 && (
          <div className="palette-suggestions">
            {suggestions.map((s, i) => {
              const Icon = KIND_ICON[s.kind] ?? IconGlobe
              return (
                <div
                  key={`${s.url}-${i}`}
                  className={`palette-suggestion ${i === selected ? 'selected' : ''}`}
                  onMouseEnter={() => setSelected(i)}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    submit(s.url)
                  }}
                >
                  <span className="s-icon">
                    <Icon size={15} />
                  </span>
                  <span className="s-text">{s.title || s.text}</span>
                  <span className="s-url">{s.title ? s.text : ''}</span>
                </div>
              )
            })}
          </div>
        )}
        <div className="palette-hint">
          <span>↩ open</span>
          <span>↑↓ select</span>
          <span>esc dismiss</span>
        </div>
      </div>
    </div>
  )
}
