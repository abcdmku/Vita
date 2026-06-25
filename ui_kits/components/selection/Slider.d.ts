import * as React from 'react';
/** Continuous value control (brightness, volume, opacity). Cosmetic — drive `value` from parent state. */
export interface SliderProps { value?: number; min?: number; max?: number; accent?: string; width?: number; }
export function Slider(props: SliderProps): JSX.Element;
