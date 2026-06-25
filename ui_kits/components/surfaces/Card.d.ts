import * as React from 'react';
/**
 * Generic surface container with optional header + action slot.
 * @startingPoint section="Surfaces" subtitle="Panel with header + content" viewport="720x250"
 */
export interface CardProps { title?: React.ReactNode; action?: React.ReactNode; children?: React.ReactNode; padding?: number; elevation?: '0' | '1' | '2' | '3'; }
export function Card(props: CardProps): JSX.Element;
