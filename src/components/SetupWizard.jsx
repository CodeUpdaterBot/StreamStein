import { useState } from "react";
import SetupScreen from "./SetupScreen";
import SetupFoldersScreen from "./SetupFoldersScreen";
import { WarningIcon } from "./Icons";
import { isElectron } from "../utils/storage";

function TmdbSkipConfirm({ onConfirm, onCancel }) {
  return (
    <div
      className="setup-confirm-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="setup-skip-title"
    >
      <div className="setup-confirm-box">
        <div className="setup-confirm-icon">
          <WarningIcon size={24} />
        </div>
        <div id="setup-skip-title" className="setup-confirm-title">
          Skip TMDB setup?
        </div>
        <p className="setup-confirm-body">
          Streamstein relies on TMDB for posters, descriptions, search, and
          browsing. Without a valid <strong>Read Access Token</strong>, the app
          will not work properly — home, library, and detail pages will stay
          empty or broken.
        </p>
        <p className="setup-confirm-body setup-confirm-emphasis">
          You only need to add this once; after that it is saved securely on
          this device. We strongly recommend getting your free token before
          continuing.
        </p>
        <div className="setup-confirm-actions">
          <button
            type="button"
            className="btn btn-ghost"
            style={{ flex: 1 }}
            onClick={onCancel}
          >
            Go back
          </button>
          <button
            type="button"
            className="btn"
            style={{
              flex: 1,
              background: "var(--red)",
              color: "#fff",
              border: "none",
              fontWeight: 600,
            }}
            onClick={onConfirm}
          >
            I understand, skip anyway
          </button>
        </div>
      </div>
    </div>
  );
}

export default function SetupWizard({
  initialStep = "tmdb",
  initialToken = "",
  initialMoviesFolder = "",
  initialYoutubeFolder = "",
  isRetest = false,
  onSaveApiKey,
  onSkipTmdb,
  onComplete,
}) {
  const [step, setStep] = useState(initialStep);
  const [showSkipConfirm, setShowSkipConfirm] = useState(false);
  const [tokenDraft, setTokenDraft] = useState(initialToken);

  const goToFoldersOrFinish = () => {
    if (isElectron) setStep("folders");
    else onComplete?.();
  };

  const handleTmdbSave = (token) => {
    onSaveApiKey?.(token);
    setTokenDraft(token);
    goToFoldersOrFinish();
  };

  const handleSkipConfirm = () => {
    setShowSkipConfirm(false);
    onSkipTmdb?.();
    goToFoldersOrFinish();
  };

  if (step === "folders") {
    return (
      <SetupFoldersScreen
        key={`folders-${initialMoviesFolder}|${initialYoutubeFolder}`}
        initialMoviesFolder={initialMoviesFolder}
        initialYoutubeFolder={initialYoutubeFolder}
        prefillDefaults={!isRetest}
        onComplete={onComplete}
        stepLabel={
          isRetest
            ? "Setup wizard · step 2 of 2"
            : "First-time setup · step 2 of 2"
        }
      />
    );
  }

  return (
    <>
      <SetupScreen
        initialToken={tokenDraft || initialToken}
        onSave={handleTmdbSave}
        onSkip={() => setShowSkipConfirm(true)}
        stepLabel={
          isRetest
            ? "Setup wizard · step 1 of 2"
            : "First-time setup · step 1 of 2"
        }
      />
      {showSkipConfirm && (
        <TmdbSkipConfirm
          onCancel={() => setShowSkipConfirm(false)}
          onConfirm={handleSkipConfirm}
        />
      )}
    </>
  );
}
