import express from 'express'
import socket from 'socket.io'
import mongoose from 'mongoose'
import redis from 'redis'

mongoose.set('useNewUrlParser', true)
mongoose.set('useFindAndModify', false)
mongoose.set('useCreateIndex', true)
// connect to replicaset
mongoose.connect('mongodb://localhost:27017/test', {useNewUrlParser: true, useUnifiedTopology: true})

const client = redis.createClient() //creates a new client
client.del("users") // We want a fresh new list!


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
 * Liste des utilisateurs en train de saisir un message
 */
const typingUsers = [];

const initUser = async socket => {
  /**
   * Emission d'un événement "user-login" pour chaque utilisateur connecté
   */
  client.lrange('users', 0, -1, (error, response) => {
    response.map(username => ({username})).forEach(user =>  socket.emit('user-login', user))
  })

  /**
   * Emission d'un événement "chat-message" pour chaque message de l'historique
   */
  const dbMessages = await Message.find({}).sort({date: -1}).limit(50)
  dbMessages.reverse().forEach(message => {
    if (message.type === 'chat') socket.emit('chat-message', message)
    else socket.emit('service', message)
  })
}

io.on('connection', async socket => {
  /**
   * Utilisateur connecté à la socket
   */
  var loggedUser;

  initUser(socket).catch(console.error)


  /**
   * Déconnexion d'un utilisateur
   */
  socket.on('disconnect', async () => {
    if (loggedUser !== undefined) {
      // Broadcast d'un 'service-message'
      const serviceMessage = {
        text: 'User "' + loggedUser.username + '" disconnected',
        type: 'logout',
      };
      socket.broadcast.emit('service-message', serviceMessage);
      // Suppression de la liste des connectés
      client.lrem("users", loggedUser.username, () => console.log(loggedUser.username  + " s'est déconnecté"))

      // Ajout du message à l'historique
      await Message.create(serviceMessage)
      // Emission d'un 'user-logout' contenant le user
      io.emit('user-logout', loggedUser);
      // Si jamais il était en train de saisir un texte, on l'enlève de la liste

      const typingUserIndex = typingUsers.indexOf(loggedUser);
      if (typingUserIndex !== -1) {
        typingUsers.splice(typingUserIndex, 1);
      }
    }
  });

  /**
   * Connexion d'un utilisateur via le formulaire :
   */
  socket.on('user-login', (user, callback) => {
    if (user === undefined) {
      callback(false)
      return
    }

    client.lpos("users", user.username, async (err, index) => {
      if (index !== null) callback(false)
      else {
        // Sauvegarde de l'utilisateur et ajout à la liste des connectés
        loggedUser = user

        client.rpush("users", loggedUser.username, (err, reply) => {
          console.log(loggedUser.username  + " s'est connecté");
          console.log(reply + " utilisateurs connectés")
        })


        // Envoi et sauvegarde des messages de service
        const userServiceMessage = {
          text: 'You logged in as "' + loggedUser.username + '"',
          type: 'login'
        }

        const broadcastServiceMessage = {
          text: 'User "' + loggedUser.username + '" logged in',
          type: 'login'
        }

        socket.emit('service-message', userServiceMessage)
        socket.broadcast.emit('service-message', broadcastServiceMessage)

        await Message.create(broadcastServiceMessage)
        // Emission de 'user-login' et appel du callback
        io.emit('user-login', loggedUser);
        callback(true);
      }
    })
  });

  /**
   * Réception de l'événement 'chat-message' et réémission vers tous les utilisateurs
   */
  socket.on('chat-message', async (message) => {
    // Sauvegarde du message
    await Message.create({
      text: message.text,
      username: loggedUser.username
    })

    // emission du message
    io.emit('chat-message', {
      text: message.text,
      username: loggedUser.username,
      type: 'chat-message'
    })
  })

  /**
   * Réception de l'événement 'start-typing'
   * L'utilisateur commence à saisir son message
   */
  socket.on('start-typing', function () {
    // Ajout du user à la liste des utilisateurs en cours de saisie
    if (!typingUsers.includes(loggedUser)) typingUsers.push(loggedUser)
    io.emit('update-typing', typingUsers)
  })

  /**
   * Réception de l'événement 'stop-typing'
   * L'utilisateur a arrêter de saisir son message
   */
  socket.on('stop-typing', function () {
    const typingUserIndex = typingUsers.indexOf(loggedUser);
    if (typingUserIndex !== -1) {
      typingUsers.splice(typingUserIndex, 1);
    }
    io.emit('update-typing', typingUsers);
  })
})

app.get('/stats', async (req,res) => {
  const chatty = await Message.aggregate([
    {
      $match: {
        username: { $ne : null }
      },
    },
    {
      $group: {
        _id: '$username',
        count: { $sum: 1 }
      }
    },
    {
      $sort: {
        count: -1
      }
    }
  ])
  res.json({chatty})
})
