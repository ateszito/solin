// ============================================================
// Solin — VideoPlayer.jsx
// React component for playing recipe video tutorials with
// timestamp-synced step highlighting and ingredient check-off.
// ============================================================
import React, { useState, useRef, useEffect } from 'react';

const VideoPlayer = ({
  videoUrl,
  title = 'Recipe Video',
  creator = 'Unknown Creator',
  steps = [],
  ingredients = [],
  onStepChange = null,
  onIngredientChange = null,
  className = '',
}) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [showOverlay, setShowOverlay] = useState(true);
  const [overlayVisible, setOverlayVisible] = useState(true);
  const [currentStep, setCurrentStep] = useState(0);
  const [checkedIngredients, setCheckedIngredients] = useState(new Set());
  const [showControls, setShowControls] = useState(true);
  const videoRef = useRef(null);
  const controlsTimerRef = useRef(null);
  const overlayTimerRef = useRef(null);

  // Track current step based on video time
  useEffect(() => {
    const handleTimeUpdate = () => {
      const time = videoRef.current?.currentTime || 0;
      setCurrentTime(time);
      let activeStep = 0;
      for (let i = 0; i < steps.length; i++) {
        const start = parseTimestamp(steps[i].video_start || steps[i].start);
        const end = parseTimestamp(steps[i].video_end || steps[i].end);
        if (time >= start && time < end) {
          activeStep = i + 1;
          break;
        }
      }
      setCurrentStep(activeStep);
      if (onStepChange && activeStep !== currentStep) {
        onStepChange(activeStep, steps[activeStep - 1] || null);
      }
    };

    const video = videoRef.current;
    if (video) {
      video.addEventListener('timeupdate', handleTimeUpdate);
      const loadedMetadata = () => setDuration(video.duration);
      video.addEventListener('loadedmetadata', loadedMetadata);
      return () => {
        video.removeEventListener('timeupdate', handleTimeUpdate);
        video.removeEventListener('loadedmetadata', loadedMetadata);
      };
    }
  }, [steps, onStepChange]);

  const togglePlay = () => {
    if (videoRef.current) {
      if (isPlaying) videoRef.current.pause();
      else videoRef.current.play();
      setIsPlaying(!isPlaying);
    }
  };

  const skip = (seconds) => {
    if (videoRef.current) {
      videoRef.current.currentTime = Math.max(0, Math.min(videoRef.current.duration, currentTime + seconds));
    }
  };

  const handleVideoClick = () => {
    togglePlay();
  };

  const jumpToStep = (stepIndex) => {
    if (videoRef.current && steps[stepIndex]) {
      const time = parseTimestamp(steps[stepIndex].video_start || steps[stepIndex].start);
      videoRef.current.currentTime = time;
      videoRef.current.play();
      setIsPlaying(true);
      setShowControls(true);
    }
  };

  const handleMouseMove = () => {
    setOverlayVisible(true);
    setShowControls(true);
    clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = setTimeout(() => setShowControls(false), 3000);
    clearTimeout(overlayTimerRef.current);
    overlayTimerRef.current = setTimeout(() => setOverlayVisible(false), 3000);
  };

  const toggleIngredient = (index) => {
    const newChecked = new Set(checkedIngredients);
    if (newChecked.has(index)) newChecked.delete(index);
    else newChecked.add(index);
    setCheckedIngredients(newChecked);
    if (onIngredientChange) {
      onIngredientChange(index, newChecked.size, ingredients.length);
    }
  };

  const progressPercent = duration ? (currentTime / duration) * 100 : 0;
  const checkedCount = checkedIngredients.size;
  const totalIngredients = ingredients.length;
  const progress = totalIngredients > 0 ? (checkedCount / totalIngredients) * 100 : 0;
  const checkedPercent = totalIngredients > 0 ? (currentStep / steps.length) * 100 : 0;

  return React.createElement('div', { className: `solin-video-player ${className}` },
    // --- VIDEO AREA ---
    React.createElement('div', {
      className: 'solin-video-wrapper',
      onMouseMove: handleMouseMove,
      onClick: handleVideoClick,
    },
      React.createElement('video', {
        ref: videoRef,
        src: videoUrl,
        playsInline: true,
        preload: 'metadata',
      }),

      // Creator overlay (fades after 3s or on mouse move)
      overlayVisible && React.createElement('div', {
        className: `solin-video-overlay ${overlayVisible ? '' : 'hidden'}`,
      },
        React.createElement('div', { className: 'solin-video-creator' }, creator),
        React.createElement('div', { className: 'solin-video-title' }, title),
      ),

      // Controls overlay
      showControls && React.createElement('div', { className: 'solin-video-controls' },
        React.createElement('div', { className: 'solin-video-progress-track' },
          React.createElement('div', {
            className: 'solin-video-progress-fill',
            style: { width: `${progressPercent}%` },
          }),
        ),
        React.createElement('div', { className: 'solin-video-controls-row' },
          React.createElement('div', { className: 'solin-video-controls-left' },
            React.createElement('button', {
              className: 'solin-video-ctrl-btn',
              onClick: (e) => { e.stopPropagation(); skip(-15); },
            }, '⏪'),
            React.createElement('button', {
              className: 'solin-video-ctrl-btn solin-play-btn',
              onClick: (e) => { e.stopPropagation(); togglePlay(); },
            }, isPlaying ? '⏸' : '▶️'),
            React.createElement('button', {
              className: 'solin-video-ctrl-btn',
              onClick: (e) => { e.stopPropagation(); skip(15); },
            }, '⏩'),
          ),
          React.createElement('div', { className: 'solin-video-timestamp' },
            `${formatTime(currentTime)} / ${formatTime(duration)}`
          ),
          React.createElement('div', { className: 'solin-video-controls-right' },
            React.createElement('button', {
              className: 'solin-video-ctrl-btn',
              onClick: (e) => { e.stopPropagation(); skip(0); },
            }, '🔁'),
          ),
        ),
      ),
    ),

    // --- RECIPE METADATA ---
    React.createElement('div', { className: 'solin-recipe-header' },
      React.createElement('h2', { className: 'solin-recipe-title' }, title),
      React.createElement('div', { className: 'solin-recipe-meta' },
        React.createElement('span', { className: 'solin-recipe-creator' }, creator),
      ),
    ),

    // --- MACRO CARDS ---
    React.createElement('div', { className: 'solin-macros-section' },
      React.createElement('div', { className: 'solin-macros-header' }, 'NUTRITION PER SERVING'),
      React.createElement('div', { className: 'solin-macros-grid' },
        React.createElement('div', { className: 'solin-macro-card' },
          React.createElement('div', { className: 'solin-macro-value' }, '850'),
          React.createElement('div', { className: 'solin-macro-label' }, 'kcal'),
        ),
        React.createElement('div', { className: 'solin-macro-card solin-protein' },
          React.createElement('div', { className: 'solin-macro-value' }, '45'),
          React.createElement('div', { className: 'solin-macro-label' }, 'protein (g)'),
        ),
        React.createElement('div', { className: 'solin-macro-card solin-carbs' },
          React.createElement('div', { className: 'solin-macro-value' }, '48'),
          React.createElement('div', { className: 'solin-macro-label' }, 'carbs (g)'),
        ),
        React.createElement('div', { className: 'solin-macro-card solin-fat' },
          React.createElement('div', { className: 'solin-macro-value' }, '29'),
          React.createElement('div', { className: 'solin-macro-label' }, 'fat (g)'),
        ),
      ),
    ),

    // --- INGREDIENTS ACCORDION ---
    React.createElement('div', { className: 'solin-accordion' },
      React.createElement('div', { className: 'solin-accordion-header' },
        React.createElement('span', null, `🛒 Ingredients (${totalIngredients})`),
        React.createElement('span', { className: 'solin-accordion-chevron' }, '▼'),
      ),
      React.createElement('div', { className: 'solin-accordion-content' },
        React.createElement('div', { className: 'solin-progress-wrapper' },
          React.createElement('div', { className: 'solin-progress-bar' },
            React.createElement('div', {
              className: 'solin-progress-fill',
              style: { width: `${progress}%` },
            }),
          ),
          React.createElement('div', { className: 'solin-progress-text' },
            `${checkedCount} / ${totalIngredients} checked`
          ),
        ),
        ingredients.map((ing, i) =>
          React.createElement('div', {
            key: i,
            className: `solin-ingredient-item ${checkedIngredients.has(i) ? 'checked' : ''}`,
            onClick: () => toggleIngredient(i),
          },
            React.createElement('div', { className: 'solin-ingredient-left' },
              React.createElement('div', { className: 'solin-ingredient-checkbox' }),
              React.createElement('div', null,
                React.createElement('div', { className: 'solin-ingredient-name' }, ing.name),
                React.createElement('div', { className: 'solin-ingredient-amount' },
                  `${ing.amount} ${ing.unit}${ing.prep ? ' — ' + ing.prep : ''}`
                ),
              ),
            ),
          )
        ),
      ),
    ),

    // --- STEPS ACCORDION ---
    React.createElement('div', { className: 'solin-accordion' },
      React.createElement('div', { className: 'solin-accordion-header' },
        React.createElement('span', null, `👨‍🍳 Steps (${steps.length})`),
        React.createElement('span', { className: 'solin-accordion-chevron' }, '▼'),
      ),
      React.createElement('div', { className: 'solin-accordion-content' },
        React.createElement('div', { className: 'solin-progress-wrapper' },
          React.createElement('div', { className: 'solin-progress-bar' },
            React.createElement('div', {
              className: 'solin-progress-fill',
              style: { width: `${checkedPercent}%` },
            }),
          ),
          React.createElement('div', { className: 'solin-progress-text' },
            `Step ${currentStep} / ${steps.length}`
          ),
        ),
        steps.map((step, i) =>
          React.createElement('div', {
            key: i,
            className: `solin-step-item ${currentStep === i + 1 ? 'active' : ''}`,
          },
            React.createElement('div', { className: 'solin-step-left' },
              React.createElement('div', { className: 'solin-step-number' }, step.number || i + 1),
              React.createElement('div', { className: 'solin-step-content' },
                React.createElement('div', { className: 'solin-step-instruction' }, step.instruction),
                step.video_start && React.createElement('div', { className: 'solin-step-timestamp' },
                  `📺 ${step.video_start} — ${step.video_end || '?'}`
                ),
                step.temperature && React.createElement('div', { className: 'solin-step-timestamp' },
                  `🌡 ${step.temperature}`
                ),
                step.tips && React.createElement('div', { className: 'solin-step-tip' }, `💡 ${step.tips}`),
                React.createElement('button', {
                  className: 'solin-step-video-link',
                  onClick: () => jumpToStep(i),
                }, '▶ Jump to video'),
              ),
            ),
          )
        ),
      ),
    ),
  );
};

// === Utility Functions ===
function parseTimestamp(ts) {
  if (!ts) return 0;
  const parts = ts.split(':');
  const secParts = parts[1] ? parts[1].split('.') : ['0'];
  return parseInt(parts[0]) * 60 + parseInt(secParts[0]) + parseFloat(secParts[1] || '0') / 1000;
}

function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export default VideoPlayer;

// For CDN/demo usage without build tools, expose globally
if (typeof window !== 'undefined') {
  window.SolinVideoPlayer = VideoPlayer;
}
