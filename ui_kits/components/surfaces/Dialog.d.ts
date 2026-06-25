import * as React from 'react';
/** Modal dialog with title, message and confirm/cancel actions. Set `overlay` to render the scrim. */
export interface DialogProps { title?: string; message?: string; children?: React.ReactNode; confirmLabel?: string; cancelLabel?: string; tone?: 'danger' | 'accent'; width?: number; overlay?: boolean; onConfirm?: () => void; onCancel?: () => void; }
export function Dialog(props: DialogProps): JSX.Element;
