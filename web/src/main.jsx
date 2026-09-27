import React from 'react';
import { createRoot } from 'react-dom/client';
import 'leaflet/dist/leaflet.css';
import './styles.css';
import './sidebar.css';
import './results.css';
import './dashboard.css';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(<App />);
