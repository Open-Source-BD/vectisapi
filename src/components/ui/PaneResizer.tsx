interface PaneResizerProps {
  onDrag: (clientY: number) => void;
}

export function PaneResizer({ onDrag }: PaneResizerProps) {
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const move = (ev: PointerEvent) => onDrag(ev.clientY);
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  };

  return (
    <div className="pane-resizer" onPointerDown={onPointerDown} title="Drag to resize">
      <div className="pane-resizer-grip" />
    </div>
  );
}
