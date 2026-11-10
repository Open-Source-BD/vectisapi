export interface MenuItem {
  label: string;
  icon: string;
  onClick: () => void;
  danger?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  return (
    <div
      className="context-menu-backdrop"
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="context-menu" style={{ top: y, left: x }} onClick={(e) => e.stopPropagation()}>
        {items.map((item) => (
          <button
            key={item.label}
            className={`context-menu-item ${item.danger ? 'danger' : ''}`}
            onClick={() => {
              item.onClick();
              onClose();
            }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
              {item.icon}
            </span>
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}
