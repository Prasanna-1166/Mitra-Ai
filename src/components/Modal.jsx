import { useEffect, useRef } from 'react';
import PropTypes from 'prop-types';

// Native <dialog>: showModal() traps focus, makes the page inert, closes on Escape
// and returns focus to the opener. Children are mounted only while open, so form
// state resets every time the dialog is reopened.
const Modal = ({ open, onClose, labelledBy, size = 'md', role = 'dialog', children }) => {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`dialog dialog-${size}`}
      role={role}
      aria-labelledby={labelledBy}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {open && children}
    </dialog>
  );
};

Modal.propTypes = {
  open: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  labelledBy: PropTypes.string,
  size: PropTypes.oneOf(['sm', 'md', 'lg']),
  role: PropTypes.string,
  children: PropTypes.node,
};

export default Modal;
