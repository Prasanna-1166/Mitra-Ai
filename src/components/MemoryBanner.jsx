import PropTypes from 'prop-types';
import Icon from './Icon';

// A pending memory suggestion (needs confirmation) or the result of an explicit
// "remember …" request. Shown just above the composer.
const MemoryBanner = ({ suggestion, notice, onAccept, onDismiss, onDismissNotice, onUndo, onManage }) => {
  if (suggestion) {
    return (
      <div className="memory-banner" role="group" aria-label="Memory suggestion">
        <Icon name="bookmark" size={16} />
        <span className="memory-banner-text">Save to memory: <q>{suggestion.text}</q></span>
        <button type="button" className="btn btn-sm btn-primary" onClick={onAccept}>Save</button>
        <button type="button" className="btn btn-sm" onClick={onDismiss}>Not now</button>
      </div>
    );
  }
  if (notice) {
    return (
      <div className={`memory-banner ${notice.kind === 'error' ? 'is-error' : ''}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
        <Icon name={notice.kind === 'error' ? 'alert' : 'bookmark'} size={16} />
        <span className="memory-banner-text">
          {notice.kind === 'saved' ? <>Saved to memory: <q>{notice.text}</q></> : notice.text}
        </span>
        {notice.kind === 'saved' && (
          <>
            <button type="button" className="btn btn-sm" onClick={() => onUndo(notice.id)}>Undo</button>
            <button type="button" className="btn btn-sm btn-quiet" onClick={onManage}>Manage</button>
          </>
        )}
        <button type="button" className="icon-btn icon-btn-sm" onClick={onDismissNotice} aria-label="Dismiss"><Icon name="x" size={14} /></button>
      </div>
    );
  }
  return null;
};
MemoryBanner.propTypes = {
  suggestion: PropTypes.shape({ text: PropTypes.string }),
  notice: PropTypes.shape({ kind: PropTypes.string, text: PropTypes.string, id: PropTypes.string }),
  onAccept: PropTypes.func.isRequired, onDismiss: PropTypes.func.isRequired, onDismissNotice: PropTypes.func.isRequired,
  onUndo: PropTypes.func.isRequired, onManage: PropTypes.func.isRequired,
};
export default MemoryBanner;
