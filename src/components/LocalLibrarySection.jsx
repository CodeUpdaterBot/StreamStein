import { useCallback, useMemo } from "react";
import MediaCard from "./MediaCard";
import { getRatingForItem } from "../utils/useRatings";
import { isRestricted } from "../utils/ageRating";

const HOME_PREVIEW_LIMIT = 20;

export default function LocalLibrarySection({
  items,
  title = "Your Library",
  onSelect,
  onShowAll,
  onOpenUntracked,
  watched,
  onMarkWatched,
  onMarkUnwatched,
  progress = {},
  ratingsMap = {},
  ageLimitSetting = 21,
  viewMode = "carousel",
  variant = "home",
  previewLimit = HOME_PREVIEW_LIMIT,
}) {
  const displayItems = useMemo(
    () => (previewLimit ? items.slice(0, previewLimit) : items),
    [items, previewLimit],
  );

  const handleCardClick = useCallback(
    (item) => {
      if (item._isUntracked) {
        onOpenUntracked?.(item);
        return;
      }
      onSelect?.({
        id: item.id,
        media_type: item.media_type,
        title: item.title,
        name: item.name,
        poster_path: item.poster_path,
      });
    },
    [onSelect, onOpenUntracked],
  );

  if (!items || items.length === 0) return null;

  const titleClass =
    variant === "library" ? "library-section-title" : "section-title";
  const sectionClass = variant === "library" ? "library-section" : "section";
  const gridClass = viewMode === "list" ? "cards-grid" : "scroll-row";

  return (
    <div className={sectionClass}>
      <div className={`${titleClass} section-title--with-action`}>
        <span className="section-title__label">
          {title}
          {variant === "library" && (
            <span
              style={{
                fontWeight: 400,
                marginLeft: 8,
                color: "var(--text3)",
              }}
            >
              ({items.length})
            </span>
          )}
        </span>
        {onShowAll && (
          <button
            type="button"
            className="section-show-all"
            onClick={onShowAll}
          >
            SHOW ALL
          </button>
        )}
      </div>
      <div className={gridClass}>
        {displayItems.map((item) => {
          const type =
            item.media_type === "tv"
              ? "tv"
              : item.media_type === "movie"
                ? "movie"
                : "local";
          const rk = type === "local" ? null : `${type}_${item.id}`;
          const cert = rk ? getRatingForItem(item, ratingsMap).cert : null;
          const restr = cert
            ? isRestricted(
                getRatingForItem(item, ratingsMap).minAge,
                ageLimitSetting,
              )
            : false;
          const pk =
            type === "movie"
              ? `movie_${item.id}`
              : type === "tv"
                ? `tv_${item.id}`
                : null;

          return (
            <MediaCard
              key={
                item._isUntracked
                  ? `local_${item.id}`
                  : `${item.media_type}_${item.id}`
              }
              item={item}
              onClick={() => handleCardClick(item)}
              progress={pk ? progress[pk] || 0 : 0}
              watched={watched}
              onMarkWatched={onMarkWatched}
              onMarkUnwatched={onMarkUnwatched}
              ageRating={cert}
              restricted={restr}
            />
          );
        })}
      </div>
    </div>
  );
}
