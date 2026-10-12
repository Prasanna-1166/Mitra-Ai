import { useId, useState } from 'react';
import PropTypes from 'prop-types';
import Icon from './Icon';

const Switch = ({ checked, onChange, label, description }) => {
  const id = useId();
  return (
    <div className="switch-row">
      <div>
        <label htmlFor={id}>{label}</label>
        {description && <p className="field-hint">{description}</p>}
      </div>
      <input id={id} type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </div>
  );
};
Switch.propTypes = { checked: PropTypes.bool.isRequired, onChange: PropTypes.func.isRequired, label: PropTypes.string.isRequired, description: PropTypes.string };

const MemoryItem = ({ memory, onUpdate, onRemove, reportError }) => {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(memory.content);
  const run = async (fn) => {
    try {
      await fn();
      return true;
    } catch (err) {
      reportError(err.message);
      return false;
    }
  };
  if (editing) {
    return (
      <li className="memory-item">
        <form
          className="memory-edit"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await run(() => onUpdate(memory.id, { content: text }))) setEditing(false);
          }}
        >
          <input value={text} maxLength={500} onChange={(e) => setText(e.target.value)} aria-label="Memory text" autoFocus />
          <button type="submit" className="btn btn-sm btn-primary">Save</button>
          <button type="button" className="btn btn-sm" onClick={() => { setEditing(false); setText(memory.content); }}>Cancel</button>
        </form>
      </li>
    );
  }
  return (
    <li className={`memory-item ${memory.enabled ? '' : 'is-off'}`}>
      <span className="memory-text">{memory.content}</span>
      <span className="memory-actions">
        <input
          type="checkbox" role="switch" checked={memory.enabled}
          onChange={(e) => run(() => onUpdate(memory.id, { enabled: e.target.checked }))}
          aria-label={`Use this memory: ${memory.content}`}
        />
        <button type="button" className="icon-btn icon-btn-sm" onClick={() => setEditing(true)} aria-label={`Edit memory: ${memory.content}`} title="Edit"><Icon name="pencil" size={14} /></button>
        <button type="button" className="icon-btn icon-btn-sm" onClick={() => run(() => onRemove(memory.id))} aria-label={`Delete memory: ${memory.content}`} title="Delete"><Icon name="trash" size={14} /></button>
      </span>
    </li>
  );
};
MemoryItem.propTypes = { memory: PropTypes.object.isRequired, onUpdate: PropTypes.func.isRequired, onRemove: PropTypes.func.isRequired, reportError: PropTypes.func.isRequired };

const MemoryPanel = ({ settings, memories, error, onMemoryEnabled, onAutoMemory, onAdd, onUpdate, onRemove, onClearAll }) => {
  const [draft, setDraft] = useState('');
  const [localError, setLocalError] = useState(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const inputId = useId();

  const add = async (e) => {
    e.preventDefault();
    if (!draft.trim()) return;
    try {
      await onAdd(draft, { source: 'user' });
      setDraft('');
      setLocalError(null);
    } catch (err) {
      setLocalError(err.message);
    }
  };

  return (
    <div className="memory-panel">
      <p className="field-hint">
        Memory keeps short notes (like your preferred language or ongoing projects) so Mitra AI can personalise answers
        across conversations. It is separate from chat history. Notes you save are sent to the AI service with relevant
        questions. Never save passwords or keys.
      </p>
      <Switch checked={settings.memory_enabled} onChange={onMemoryEnabled} label="Use memory" description="When off, saved notes are kept but not used." />
      <Switch checked={settings.auto_memory} onChange={onAutoMemory} label="Suggest memories" description="Offers to save useful preferences. Nothing is saved without your confirmation." />

      <form className="memory-add" onSubmit={add}>
        <label htmlFor={inputId} className="sr-only">Add a memory</label>
        <input id={inputId} value={draft} maxLength={500} onChange={(e) => setDraft(e.target.value)} placeholder="Add a note, e.g. “I prefer TypeScript examples”" />
        <button type="submit" className="btn btn-sm" disabled={!draft.trim()}>Add</button>
      </form>
      {(localError || error) && <p className="field-error" role="alert">{localError || error}</p>}

      {memories.length === 0 ? (
        <p className="sidebar-empty">No saved memories yet.</p>
      ) : (
        <ul className="memory-list">
          {memories.map((m) => (
            <MemoryItem key={m.id} memory={m} onUpdate={onUpdate} onRemove={onRemove} reportError={setLocalError} />
          ))}
        </ul>
      )}

      {memories.length > 0 && (confirmClear ? (
        <div className="inline-confirm" role="alert">
          <span>Delete all {memories.length} memories?</span>
          <button type="button" className="btn btn-sm btn-danger" onClick={async () => { try { await onClearAll(); } catch (err) { setLocalError(err.message); } setConfirmClear(false); }}>Delete all</button>
          <button type="button" className="btn btn-sm" onClick={() => setConfirmClear(false)} autoFocus>Cancel</button>
        </div>
      ) : (
        <button type="button" className="btn btn-sm btn-quiet" onClick={() => setConfirmClear(true)}>Clear all memories</button>
      ))}
    </div>
  );
};
MemoryPanel.propTypes = {
  settings: PropTypes.shape({ memory_enabled: PropTypes.bool, auto_memory: PropTypes.bool }).isRequired,
  memories: PropTypes.arrayOf(PropTypes.object).isRequired, error: PropTypes.string,
  onMemoryEnabled: PropTypes.func.isRequired, onAutoMemory: PropTypes.func.isRequired,
  onAdd: PropTypes.func.isRequired, onUpdate: PropTypes.func.isRequired, onRemove: PropTypes.func.isRequired, onClearAll: PropTypes.func.isRequired,
};
export default MemoryPanel;
