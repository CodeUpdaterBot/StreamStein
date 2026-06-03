import { useState, useRef, useEffect, useMemo } from "react";
import { imgUrl } from "../utils/api";
import {
  loadSidebarLayout,
  partitionSidebarNav,
  SIDEBAR_LAYOUT_CHANGED,
  SIDEBAR_ITEM_LABELS,
} from "../utils/sidebarLayout";
import {
  StreamsteinLogo,
  HomeIcon,
  YouTubeIcon,
  SearchIcon,
  HistoryIcon,
  FilmIcon,
  SettingsIcon,
  DownloadsQueueIcon,
  QuitIcon,
  BackIcon,
  HelpIcon,
} from "./Icons";

const NAV_RENDERERS = {
  home: {
    icon: <HomeIcon />,
    label: SIDEBAR_ITEM_LABELS.home,
    page: "home",
  },
  history: {
    icon: <HistoryIcon />,
    label: SIDEBAR_ITEM_LABELS.history,
    page: "history",
  },
  downloads: {
    icon: <DownloadsQueueIcon />,
    label: SIDEBAR_ITEM_LABELS.downloads,
    page: "downloads",
  },
  youtube: {
    icon: <YouTubeIcon />,
    label: SIDEBAR_ITEM_LABELS.youtube,
    page: "youtube",
  },
  help: {
    icon: <HelpIcon />,
    label: `${SIDEBAR_ITEM_LABELS.help} (?)`,
    action: "help",
  },
  settings: {
    icon: <SettingsIcon />,
    label: SIDEBAR_ITEM_LABELS.settings,
    page: "settings",
  },
  quit: {
    icon: <QuitIcon />,
    label: SIDEBAR_ITEM_LABELS.quit,
    action: "quit",
  },
};

export default function Sidebar({
  page,
  onNavigate,
  onSearch,
  savedList,
  activeDownloads,
  onReorderSaved,
  onRemoveSaved,
  canGoBack,
  onBack,
  onShowShortcuts,
}) {
  const [layout, setLayout] = useState(() => loadSidebarLayout());
  const [dragOver, setDragOver] = useState(null);
  const dragItem = useRef(null);
  const dragNode = useRef(null);

  const [tooltip, setTooltip] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);

  useEffect(() => {
    const refresh = () => setLayout(loadSidebarLayout());
    window.addEventListener(SIDEBAR_LAYOUT_CHANGED, refresh);
    return () => window.removeEventListener(SIDEBAR_LAYOUT_CHANGED, refresh);
  }, []);

  const { main: mainNav, bottom: bottomNav } = useMemo(
    () => partitionSidebarNav(layout.order, layout.visible),
    [layout],
  );

  useEffect(() => {
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
    };
  }, []);

  const handleContextMenu = (e, item) => {
    e.preventDefault();
    e.stopPropagation();
    setTooltip(null);
    setContextMenu({ item, x: e.clientX, y: e.clientY });
  };

  const handleDragStart = (e, index) => {
    dragItem.current = index;
    dragNode.current = e.currentTarget;
    setTimeout(() => {
      if (dragNode.current) dragNode.current.style.opacity = "0.4";
    }, 0);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragEnd = () => {
    if (dragNode.current) dragNode.current.style.opacity = "1";
    dragItem.current = null;
    dragNode.current = null;
    setDragOver(null);
  };

  const handleDragEnter = (e, index) => {
    if (dragItem.current === index) return;
    setDragOver(index);
  };

  const handleDrop = (e, dropIndex) => {
    e.preventDefault();
    const fromIndex = dragItem.current;
    if (fromIndex === null || fromIndex === dropIndex) return;

    const newList = [...savedList];
    const [moved] = newList.splice(fromIndex, 1);
    newList.splice(dropIndex, 0, moved);

    const newOrder = newList.map((item) => `${item.media_type}_${item.id}`);
    onReorderSaved(newOrder);
    setDragOver(null);
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };

  const handleMouseEnter = (e, title) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setTooltip({ title, y: rect.top + rect.height / 2 });
  };

  const handleMouseLeave = () => {
    setTooltip(null);
  };

  const renderNavItem = (id) => {
    const config = NAV_RENDERERS[id];
    if (!config) return null;

    if (config.action === "help") {
      return (
        <SideBtn
          key={id}
          onClick={onShowShortcuts}
          icon={config.icon}
          label={config.label}
        />
      );
    }

    if (config.action === "quit") {
      return (
        <button
          key={id}
          className="sidebar-btn"
          onClick={() => window.electron?.quitApp?.()}
          title={config.label}
          style={{ color: "#e53e3e", marginTop: id === bottomNav[0] ? 4 : 0 }}
        >
          {config.icon}
          <span className="tooltip">{config.label}</span>
        </button>
      );
    }

    return (
      <SideBtn
        key={id}
        active={page === config.page}
        onClick={() => onNavigate(config.page)}
        icon={config.icon}
        label={config.label}
        badge={
          id === "downloads" && activeDownloads > 0 ? activeDownloads : null
        }
      />
    );
  };

  return (
    <div className="sidebar">
      <div
        className="sidebar-logo"
        onClick={() => onNavigate("home")}
        title="Streamstein"
      >
        <StreamsteinLogo />
      </div>

      {canGoBack && (
        <SideBtn onClick={onBack} icon={<BackIcon />} label="Back (Ctrl+Z)" />
      )}

      <SideBtn onClick={onSearch} icon={<SearchIcon />} label="Search  (⌘F)" />

      {mainNav.map(renderNavItem)}

      <div className="sidebar-sep" />

      <div className="sidebar-saved">
        {savedList.map((item, index) => {
          const key = `${item.media_type}_${item.id}`;
          const title = item.title || item.name;
          return (
            <div
              key={key}
              className={`saved-thumb${dragOver === index ? " drag-over" : ""}`}
              draggable
              onDragStart={(e) => handleDragStart(e, index)}
              onDragEnd={handleDragEnd}
              onDragEnter={(e) => handleDragEnter(e, index)}
              onDragOver={handleDragOver}
              onDrop={(e) => handleDrop(e, index)}
              onClick={() =>
                onNavigate(item.media_type === "tv" ? "tv" : "movie", item)
              }
              onContextMenu={(e) => handleContextMenu(e, item)}
              onMouseEnter={(e) => handleMouseEnter(e, title)}
              onMouseLeave={handleMouseLeave}
              style={{ cursor: "grab", position: "relative" }}
            >
              {item.poster_path ? (
                <img src={imgUrl(item.poster_path, "w200")} alt={title} />
              ) : (
                <div className="no-img">
                  <FilmIcon />
                </div>
              )}
              {dragOver === index && (
                <div
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    height: 3,
                    background: "var(--accent, #e50914)",
                    borderRadius: 2,
                    pointerEvents: "none",
                  }}
                />
              )}
            </div>
          );
        })}
      </div>

      {tooltip && (
        <div className="saved-thumb-tooltip" style={{ top: tooltip.y }}>
          {tooltip.title}
        </div>
      )}

      {contextMenu && (
        <div
          className="sidebar-context-menu"
          style={{
            position: "fixed",
            top: contextMenu.y,
            left: contextMenu.x,
            zIndex: 9999,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="sidebar-context-menu-item"
            onClick={() => {
              onRemoveSaved && onRemoveSaved(contextMenu.item);
              setContextMenu(null);
            }}
          >
            Remove
          </div>
        </div>
      )}

      {bottomNav.length > 0 && (
        <div className="sidebar-bottom">{bottomNav.map(renderNavItem)}</div>
      )}
    </div>
  );
}

function SideBtn({ active, onClick, icon, label, badge }) {
  return (
    <button
      className={`sidebar-btn ${active ? "active" : ""}`}
      onClick={onClick}
      style={{ position: "relative" }}
    >
      {icon}
      <span className="tooltip">{label}</span>
      {badge && (
        <span
          style={{
            position: "absolute",
            top: 4,
            right: 4,
            minWidth: 16,
            height: 16,
            borderRadius: 8,
            background: "var(--red)",
            color: "white",
            fontSize: 10,
            fontWeight: 700,
            lineHeight: "16px",
            textAlign: "center",
            padding: "0 4px",
          }}
        >
          {badge}
        </span>
      )}
    </button>
  );
}
