import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

// Public client config for the "doceria-metanoia" Firebase project.
// This is not a secret: access is controlled by Firestore security rules,
// not by hiding this object. See https://firebase.google.com/docs/projects/api-keys
const firebaseConfig = {
  apiKey: "AIzaSyC4qledZnwLxOTmtTrITN7I--7Wh0pDeDs",
  authDomain: "doceria-metanoia.firebaseapp.com",
  projectId: "doceria-metanoia",
  storageBucket: "doceria-metanoia.firebasestorage.app",
  messagingSenderId: "737514216796",
  appId: "1:737514216796:web:80e06ce5de61b24178b599",
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
