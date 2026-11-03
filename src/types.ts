export type Tool =
  | 'select' | 'hand' | 'rectangle' | 'diamond' | 'ellipse'
  | 'arrow' | 'line' | 'pen' | 'text' | 'laser' | 'icon'

export type ShapeType =
  | 'rectangle' | 'diamond' | 'ellipse' | 'arrow' | 'line' | 'freedraw' | 'text' | 'image' | 'icon' | 'connector'

export interface Style {
  stroke: string
  fill: string
  strokeWidth: number
  roughness: number
  fillStyle?: 'hachure' | 'solid'
  opacity?: number // 0-100, default 100
  rounded?: boolean // rectangle with rounded corners
  dash?: boolean // dashed stroke (lines, arrows, connectors, boxes)
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
  icon?: string // component id from catalog.ts (type 'icon')
  endArrow?: boolean // connector: arrow head on the last point (default true)
  fontSize?: number
  fontFamily?: string // id from FONTS in render.ts
  align?: 'left' | 'center' | 'right' // text / caption alignment (default: left for text, center for captions)
  valign?: 'top' | 'middle' | 'bottom' // caption position inside rectangle / ellipse / diamond
  description?: string // optional explanation of what this element does; shown in a card when it is clicked
  frame?: boolean // the box drawn around a group of a generated diagram: arrows do not attach to it
  flipX?: boolean // icon / image drawn mirrored left-right
  flipY?: boolean // icon / image drawn mirrored top-bottom
  locked?: boolean // cannot be selected or moved until unlocked
  groupId?: string // elements sharing a groupId are selected and moved together (Ctrl+G)
  bindStart?: string // line/arrow: id of the element its first end is attached to
  bindEnd?: string // line/arrow: id of the element its last end is attached to
  nid?: string // id the diagram spec gave this node / group box; agents refer to it later
  grp?: string // spec id of the group a generated node belongs to
  from?: string // generated connector: element id of its source node
  to?: string // generated connector: element id of its target node
  cap?: string // generated connector / group box: its caption text
  aux?: boolean // generated caption (edge label, group title): not a node of the architecture
  of?: string // caption: element id of the connector / group box it describes
  angle?: number // rotation in radians around the box centre (not for line/arrow/connector)
}

export interface View { x: number; y: number; zoom: number }
