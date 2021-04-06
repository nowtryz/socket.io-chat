import express from 'express'
import socket from 'socket.io'
import mongoose from 'mongoose'

mongoose.set('useNewUrlParser', true);
mongoose.set('useFindAndModify', false);
mongoose.set('useCreateIndex', true);
mongoose.connect('mongodb://localhost:27017/test', {useNewUrlParser: true, useUnifiedTopology: true});

var redis = require('redis');
var client = redis.createClient(); //creates a new client


const Message = mongoose.model('Message', new mongoose.Schema({
  text: {
    type: String,
    required: true
  },
  username: String,
  date: {
    type: Date,
    default: Date.now,
    index: 1
  },
  type: {
    type: String,
    enum : ['chat','service', 'login', 'logout'],
    default: 'chat'
  },
}))

// Gestion des requêtes HTTP des utilisateurs en leur renvoyant les fichiers du dossier 'public'
const app = express().use('/', express.static( 'public'))

// Lancement du serveur en écoutant les connexions arrivant sur le port 3000
const http = app.listen(3000, () => console.log('Server is listening on *:3000'))
const io = socket(http)

/**
 * Liste des utilisateurs connectés
 */
const users = new Array();

/**
 * Historique des messages
 */
var messages = [];

/**
 * Liste des utilisateurs en train de saisir un message
 */
var typingUsers = [];

io.on('connection', async socket => {
  console.log('connection')

  /**
   * Utilisateur connecté à la socket
   */
  var loggedUser;

  /**
   * Emission d'un événement "user-login" pour chaque utilisateur connecté
   */
  users.forEach(user =>  socket.emit('user-login', user))

  /**
   * Emission d'un événement "chat-message" pour chaque message de l'historique
   */
  // TODO check if user is connected (redis) and skip this part
  const dbMessages = await Message.find({}).sort({date: -1}).limit(50)
  dbMessages.reverse().forEach(message => {
    if (message.type === 'chat') socket.emit('chat-message', message)
    else socket.emit('service', message)
  })


  /**
   * Déconnexion d'un utilisateur
   */
  socket.on('disconnect', async () => {
    console.log('disconnect')
    if (loggedUser !== undefined) {
      // Broadcast d'un 'service-message'
      var serviceMessage = {
        text: 'User "' + loggedUser.username + '" disconnected',
        type: 'logout',
      };
      socket.broadcast.emit('service-message', serviceMessage);
      // Suppression de la liste des connectés
      var userIndex = users.indexOf(loggedUser);
      if (userIndex !== -1) {
        users.splice(userIndex, 1);
        client.lrem("users", userIndex, loggedUser.username, function (err,reply){
          console.log(loggedUser.username  + " c'est déconnecté");


        })
      }
      // Ajout du message à l'historique
      await Message.create(serviceMessage)
      // Emission d'un 'user-logout' contenant le user
      io.emit('user-logout', loggedUser);
      // Si jamais il était en train de saisir un texte, on l'enlève de la liste
      var typingUserIndex = typingUsers.indexOf(loggedUser);
      if (typingUserIndex !== -1) {
        typingUsers.splice(typingUserIndex, 1);
      }
    }
  });

  /**
   * Connexion d'un utilisateur via le formulaire :
   */
  socket.on('user-login', async (user, callback) => {
    console.log('user-login')
    if (user !== undefined && !users.some(value => value.username === user.username)) { // S'il est bien nouveau
      // Sauvegarde de l'utilisateur et ajout à la liste des connectés
      loggedUser = user;
      users.push(loggedUser);

      client.rpush("users", loggedUser.username, function (err,reply){
        console.log(loggedUser.username  + " c'est connecté");
        console.log(reply + " utilisateurs connectés")
      })


      // Envoi et sauvegarde des messages de service
      var userServiceMessage = {
        text: 'You logged in as "' + loggedUser.username + '"',
        type: 'login'
      }

      var broadcastedServiceMessage = {
        text: 'User "' + loggedUser.username + '" logged in',
        type: 'login'
      }

      socket.emit('service-message', userServiceMessage)
      socket.broadcast.emit('service-message', broadcastedServiceMessage)

      await Message.create(broadcastedServiceMessage)



      // Emission de 'user-login' et appel du callback
      io.emit('user-login', loggedUser);
      callback(true);
    } else {
      callback(false);
    }
  });

  /**
   * Réception de l'événement 'chat-message' et réémission vers tous les utilisateurs
   */
  socket.on('chat-message', async (message) => {
    console.log('chat-message')
    // Sauvegarde du message
    await Message.create({
      text: message.text,
      username: loggedUser.username
    })

    // emmition du message
    io.emit('chat-message', {
      text: message.text,
      username: loggedUser.username,
      type: 'chat-message'
    })
  });

  /**
   * Réception de l'événement 'start-typing'
   * L'utilisateur commence à saisir son message
   */
  socket.on('start-typing', function () {
    console.log('start-typing')
    // Ajout du user à la liste des utilisateurs en cours de saisie
    if (typingUsers.indexOf(loggedUser) === -1) {
      typingUsers.push(loggedUser);
    }
    io.emit('update-typing', typingUsers);
  });

  /**
   * Réception de l'événement 'stop-typing'
   * L'utilisateur a arrêter de saisir son message
   */
  socket.on('stop-typing', function () {
    console.log('stop-typing')
    var typingUserIndex = typingUsers.indexOf(loggedUser);
    if (typingUserIndex !== -1) {
      typingUsers.splice(typingUserIndex, 1);
    }
    io.emit('update-typing', typingUsers);
  });
});


