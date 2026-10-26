export type Tool =
  | 'select' | 'hand' | 'rectangle' | 'diamond' | 'ellipse'
  | 'arrow' | 'line' | 'pen' | 'text' | 'laser'

export type ShapeType =
  | 'rectangle' | 'diamond' | 'ellipse' | 'arrow' | 'line' | 'freedraw' | 'text' | 'image'

export interface Style {
  stroke: string
  fill: string
  strokeWidth: number
  roughness: number
}

export interface El extends Style {
  id: string
  type: ShapeType
  x: number
  y: number
  // for line/arrow w,h are the signed delta to the end point
  w: number
  h: number
  seed: number
  points?: [number, number][] // freedraw, relative to x,y
  text?: string
  src?: string // image data URL
  fontSize?: number
  fontFamily?: string // id from FONTS in render.ts
}

export interface View { x: number; y: number; zoom: number }
