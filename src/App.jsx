import React, { useState, useEffect, useRef } from 'react';
import ChatContainer from './components/ChatContainer';
import InputArea from './components/InputArea';
import Sidebar from './components/Sidebar';

const App = () => {
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false); // Replaces isTyping, but strictly for generation state

  const websocketRef = useRef(null);
  const activeSessionRef = useRef(null); // Keep track of active session ID for callbacks

  // Configuration
  const SYSTEM_PROMPT = "You are Mitra Ai, a friendly, intelligent, and helpful AI assistant designed to race through problems and find solutions fast.";
  const APP_ID = "college-wife";

  // Update ref when state changes
  useEffect(() => {
    activeSessionRef.current = activeSessionId;
  }, [activeSessionId]);

  // Initialize with one session if none exist
  useEffect(() => {
    if (sessions.length === 0) {
      // Create initial session without triggering connect immediately, 
      // relying on the handleNewChat logic
      handleNewChat(true);
    }
  }, []);

  const activeSession = sessions.find(s => s.id === activeSessionId) || { messages: [] };

  // WebSocket Logic
  const connectWebSocket = (message, initChat, currentSessionId) => {
    setIsGenerating(true);
    const url = "wss://backend.buildpicoapps.com/api/chatbot/chat";

    // Close existing connection if any
    if (websocketRef.current) {
      websocketRef.current.close();
    }

    const ws = new WebSocket(url);
    websocketRef.current = ws;

    // Create a placeholder message for the AI response
    const aiMsgId = crypto.randomUUID();
    const aiMsg = {
      id: aiMsgId,
      role: 'assistant',
      content: '', // Start empty, fill stream
      timestamp: new Date().toISOString()
    };

    if (!initChat) {
      setSessions(prev => prev.map(session => {
        if (session.id === currentSessionId) {
          return {
            ...session,
            messages: [...session.messages, aiMsg]
          };
        }
        return session;
      }));
    }

    ws.onopen = () => {
      ws.send(JSON.stringify({
        chatId: currentSessionId, // Use the session ID as chat ID
        appId: APP_ID,
        systemPrompt: SYSTEM_PROMPT,
        message: initChat ? "A welcoming introduction from Mitra Ai" : message,
      }));
    };

    ws.onmessage = (event) => {
      // Append chunk to the latest message of the correct session
      setSessions(prev => prev.map(session => {
        if (session.id === currentSessionId) {
          const msgs = [...session.messages];
          // If initChat, we might need to add the welcome message first if it doesn't exist

          let lastMsg = msgs[msgs.length - 1];

          // Implementing "first chunk creates or appends"
          if (initChat && (!lastMsg || lastMsg.role !== 'assistant')) {
            // This is the first chunk of welcome message
            const welcomeMsg = {
              id: crypto.randomUUID(),
              role: 'assistant',
              content: event.data,
              timestamp: new Date().toISOString()
            };
            return { ...session, messages: [...msgs, welcomeMsg] };
          } else if (lastMsg && lastMsg.role === 'assistant') {
            // Append to existing assistant message
            const updatedMsg = { ...lastMsg, content: lastMsg.content + event.data };
            msgs[msgs.length - 1] = updatedMsg;
            return { ...session, messages: msgs };
          }
          return session;
        }
        return session;
      }));
    };

    ws.onclose = (event) => {
      setIsGenerating(false);
      if (event.code !== 1000) {
        // Handle error
      }
    };

    ws.onerror = (error) => {
      console.error("WebSocket Error:", error);
      setIsGenerating(false);
    };
  };

  const handleCancelGeneration = () => {
    if (websocketRef.current) {
      websocketRef.current.close(1000); // 1000 = Normal Closure
      setIsGenerating(false);
    }
  };

  const handleSendMessage = async (text) => {
    if (!activeSessionId) return;

    const timestamp = new Date().toISOString();
    const userMsg = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp
    };

    // Update active session with user message
    setSessions(prev => prev.map(session => {
      if (session.id === activeSessionId) {
        // Generate title if needed
        const newTitle = session.messages.length <= 1 ? text.slice(0, 30) + (text.length > 30 ? '...' : '') : session.title;
        return {
          ...session,
          title: newTitle,
          messages: [...session.messages, userMsg]
        };
      }
      return session;
    }));

    connectWebSocket(text, false, activeSessionId);
  };

  const handleNewChat = (isInitial = false) => {
    const newSessionId = crypto.randomUUID();
    const newSession = {
      id: newSessionId,
      title: 'New Chat',
      messages: []
    };

    setSessions(prev => [newSession, ...prev]);
    setActiveSessionId(newSessionId);

    if (window.innerWidth <= 768) setIsSidebarOpen(false);

    setTimeout(() => connectWebSocket("", true, newSessionId), 0);
  };

  const handleSwitchSession = (sessionId) => {
    if (isGenerating && websocketRef.current) {
      websocketRef.current.close(1000);
      setIsGenerating(false);
    }
    setActiveSessionId(sessionId);
  };

  const handleDeleteSession = (sessionId) => {
    if (confirm("Delete this chat?")) {
      setSessions(prev => {
        const newSessions = prev.filter(s => s.id !== sessionId);
        if (activeSessionId === sessionId) {
          if (newSessions.length > 0) {
            setActiveSessionId(newSessions[0].id);
          } else {
            const newId = crypto.randomUUID();
            setTimeout(() => {
              setSessions([{ id: newId, title: 'New Chat', messages: [] }]);
              setActiveSessionId(newId);
              connectWebSocket("", true, newId);
            }, 0);
            return [];
          }
        }
        return newSessions;
      });
    }
  };

  const handleClearCurrentChat = () => {
    if (activeSessionId) {
      if (confirm("Clear all messages in this chat?")) {
        setSessions(prev => prev.map(s => {
          if (s.id === activeSessionId) {
            return { ...s, messages: [] };
          }
          return s;
        }));
        // Optionally restart with welcome
        setTimeout(() => connectWebSocket("", true, activeSessionId), 500);
      }
    }
  };

  const handleDeleteAllSessions = () => {
    if (confirm("Are you sure you want to delete all chat history? This cannot be undone.")) {
      // Close any active websocket
      if (websocketRef.current) {
        websocketRef.current.close(1000);
        setIsGenerating(false);
      }

      // Create a fresh session
      const newId = crypto.randomUUID();
      setSessions([{ id: newId, title: 'New Chat', messages: [] }]);
      setActiveSessionId(newId);

      // Start with welcome message
      setTimeout(() => connectWebSocket("", true, newId), 500);
    }
  };

  const toggleSidebar = () => {
    setIsSidebarOpen(!isSidebarOpen);
  };

  return (
    <div className="app-container">
      <header className="app-header">
        <button onClick={toggleSidebar} className="menu-btn" aria-label="Toggle sidebar">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="3" y1="12" x2="21" y2="12"></line>
            <line x1="3" y1="6" x2="21" y2="6"></line>
            <line x1="3" y1="18" x2="21" y2="18"></line>
          </svg>
        </button>
        <div className="app-title">Mitra Ai</div>
        <div className="header-actions">
          <button onClick={() => handleNewChat(false)} className="new-chat-btn" aria-label="New chat">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
          </button>
        </div>
      </header>

      <Sidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSwitchSession={handleSwitchSession}
        onNewChat={() => handleNewChat(false)}
        onDeleteSession={handleDeleteSession}
        onDeleteAll={handleDeleteAllSessions}
        isOpen={isSidebarOpen}
        toggleSidebar={toggleSidebar}
      />

      <main className={`main-content ${isSidebarOpen ? 'shifted' : ''}`}>
        <ChatContainer messages={activeSession.messages} isTyping={isGenerating} />
        <InputArea
          onSendMessage={handleSendMessage}
          isGenerating={isGenerating}
          onCancel={handleCancelGeneration}
          onClear={handleClearCurrentChat}
        />
      </main>
    </div>
  );
};

export default App;
