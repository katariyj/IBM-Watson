'use strict';

const ConversationV1 = require('watson-developer-cloud/conversation/v1');
const Foursquare = require('foursquarevenues');

const request = require('request');
const querystring = require('querystring');

function handleRes(error, res, body, callback) {
  if (error) {
    return callback(error, null);
  } else if (res.statusCode >= 300) {
    return callback(body, null);
  } else {
    return callback(null, JSON.parse(body));
  }
};

function executeRequest(urlString, callback) {
  return request(urlString, (error, response, body) => {
    return handleRes(error, response, body, callback);
  });
}

function getWeatherInfo(params, callback) {
  // const urlString = "http://api.weather.com/v1/geocode/"+params["long"]+"/"+params["lati"]+"/forecast/daily/5day.json?apiKey=f43934a981fc48f5926e5929d3ee0760&units=e";
  var today = new Date();
    var dd = today.getDate();
    var mm = today.getMonth()+1; //January is 0!

    var yyyy = today.getFullYear();
    if(dd<10){
        dd='0'+dd;
    } 
    if(mm<10){
        mm='0'+mm;
    } 
    var today = yyyy + mm + dd;
  // 20170611
  const urlString = "http://api.weather.com/v1/geocode/"+params["long"]+"/"+params["lati"]+"/observations/historical.json?apiKey=f43934a981fc48f5926e5929d3ee0760&units=e&startDate="+today;

  return executeRequest(urlString, callback);
}

function getGoodzer(params, callback) {
  const urlString = "https://api.goodzer.com/products/v0.1/search_stores/?query="+params["query"]+"&lat="+params["lati"]+"&lng="+params["long"]+"&radius=20&priceRange=30:120&apiKey=da92d3df8fd61d84e7fabcafb156c1c4";

console.log(urlString);
  return executeRequest(urlString, callback);
}
 
class HealthBot {

    /**
     * Creates a new instance of HealthBot.
     * @param {object} userStore - Instance of CloudantUserStore used to store and retrieve users from Cloudant
     * @param {string} dialogStore - Instance of CloudantDialogStore used to store conversation history
     * @param {string} conversationUsername - The Watson Conversation username
     * @param {string} conversationPassword - The Watson Converation password
     * @param {string} conversationWorkspaceId - The Watson Conversation workspace ID
     * @param {string} foursquareClientId - The Foursquare Client ID
     * @param {string} foursquareClientSecret - The Foursquare Client Secret
     */
    constructor(userStore, dialogStore, conversationUsername, conversationPassword, conversationWorkspaceId, foursquareClientId, foursquareClientSecret) {
        this.userStore = userStore;
        this.dialogStore = dialogStore;
        this.conversationService = new ConversationV1({
            username: conversationUsername,
            password: conversationPassword,
            version_date: '2017-04-21'
        });
        this.conversationWorkspaceId = conversationWorkspaceId;
        if (foursquareClientId && foursquareClientSecret) {
            this.foursquareClient = Foursquare(foursquareClientId, foursquareClientSecret);
        }
    }

     /**
     * Initializes the bot, including the required datastores.
     */
    init() {
        return Promise.all([
            this.userStore.init(),
            this.dialogStore.init()
        ]);
    }

    /**
     * Process the message entered by the user.
     * @param {string} message - The message entered by the user
     * @returns {Promise.<string|Error>} - The reply to be sent to the user if fulfilled, or an error if rejected
     */
    processMessage(messageSender, message) {
        let user = null;
        let conversationResponse = null;
        let reply = null;
        return this.getOrCreateUser(messageSender)
            .then((u) => {
                user = u;
                return this.sendRequestToWatsonConversation(message, user.conversationContext);
            })
            .then((response) => {
                conversationResponse = response;
                return this.handleResponseFromWatsonConversation(message, user, conversationResponse);
            })
            .then((replyText) => {
                reply = replyText;
                return this.updateUserWithWatsonConversationContext(user, conversationResponse.context);
            })
            .then((u) => {
                if (reply.products) {
                    return Promise.resolve({
                        conversationResponse: conversationResponse,
                        text: reply.reply,
                        product: reply.products
                    });
                }
                else {
                    return Promise.resolve({conversationResponse: conversationResponse, text:reply});
                }
            })
            .catch((error) => {
                console.log(`Error: ${JSON.stringify(error,null,2)}`);
                let reply = "Sorry, something went wrong!";
                return Promise.resolve({conversationResponse: conversationResponse, text:reply});
            });
    }

    /**
     * Sends the message entered by the user to Watson Conversation
     * along with the active Watson Conversation context that is used to keep track of the conversation.
     * @param {string} message - The message entered by the user
     * @param {object} conversationContext - The active Watson Conversation context
     * @returns {Promise.<object|error>} - The response from Watson Conversation if fulfilled, or an error if rejected
     */
    sendRequestToWatsonConversation(message, conversationContext) {
        return new Promise((resolve, reject) => {
            var conversationRequest = {
                input: {text: message},
                context: conversationContext,
                workspace_id: this.conversationWorkspaceId,
            };
            this.conversationService.message(conversationRequest, (error, response) => {
                if (error) {
                    reject(error);
                }
                else {
                    resolve(response);
                }
            });
        });
    }
    
    /**
     * Takes the response from Watson Conversation, performs any additional steps
     * that may be required, and returns the reply that should be sent to the user.
     * @param {string} message - The message sent by the user
     * @param {object} user - The active user stored in Cloudant
     * @param {object} conversationResponse - The response from Watson Conversation
     * @returns {Promise.<string|error>} - The reply to send to the user if fulfilled, or an error if rejected
     */
    handleResponseFromWatsonConversation(message, user, conversationResponse) {
        // getOrCreateActiveConversationId will retrieve the active conversation
        // for the current user from our Cloudant log database.
        // A new conversation doc is created anytime a new conversation is started.
        // The conversationDocId is store in the Watson Conversation context,
        // so we can access it every time a new message is received from a user.
        return this.getOrCreateActiveConversationId(user, conversationResponse)
            .then(() => {
                // Every dialog in our workspace has been configured with a custom "action" that is available in the Watson Conversation context.
                // In some cases we need to take special steps and return a customized response for an action.
                // For example, we'll lookup and return a list of doctors when the action = findDoctorByLocation (handleFindDoctorByLocationMessage). 
                // In other cases we'll just return the response configured in the Watson Conversation dialog (handleDefaultMessage).
                const action = conversationResponse.context.action;
                // Variables in the context stay in there until we clear them or overwrite them, and we don't want
                // to process the wrong action if we forget to overwrite it, so here we clear the action in the context
                conversationResponse.context.action = null;
                // Process the action
                if (action == "findWeatherByLocation") {
                    return this.findWeatherByLocation(conversationResponse);
                }
                else {
                    return this.handleDefaultMessage(conversationResponse);
                }
            })
            .then((reply) => {
                // Finally, we log every action performed as part of the active conversation
                // in our Cloudant dialog database and return the reply to be sent to the user.
                this.logDialog(
                    conversationResponse.context.conversationDocId,
                    conversationResponse.context.action,
                    message,
                    reply
                );
                return Promise.resolve(reply);
            });
    }

    /**
     * The default handler for any message from Watson Conversation that requires no additional steps.
     * Returns the reply that was configured in the Watson Conversation dialog.
     * @param {object} conversationResponse - The response from Watson Conversation
     * @returns {Promise.<string|error>} - The reply to send to the user if fulfilled, or an error if rejected
     */
    handleDefaultMessage(conversationResponse) {
        let reply = '';
        for (let i = 0; i < conversationResponse.output.text.length; i++) {
            reply += conversationResponse.output.text[i] + '\n';

        }
        return Promise.resolve(reply);
    }

    /**
     * The handler for the findWeatherByLocation action defined in the Watson Conversation dialog.
     * Queries Foursquare for doctors based on the speciality identified by Watson Conversation
     * and the location entered by the user.
     * @param {object} conversationResponse - The response from Watson Conversation
     * @returns {Promise.<string|error>} - The reply to send to the user if fulfilled, or an error if rejected
     */
    findWeatherByLocation(conversationResponse) {
        // Get the location entered by the user to be used in the query
        let location = '';
        for (let i=0; i<conversationResponse.entities.length; i++) {
            if (conversationResponse.entities[0].entity == 'sys-location') {
                if (location.length > 0) {
                    location += ' ';
                }
                location += conversationResponse.entities[0].value;
            }
        }

        return new Promise((resolve, reject) => {
            var long;
            var lati;
            switch(location.toLowerCase()) {
                case "san francisco":
                    long = "37.7749";
                    lati = "-122.3139";
                break;

                case "miami":
                    long = "25.7906";
                    lati = "-80.3164";
                break;

                default:
                    long = "39.8328";
                    lati = "-104.6575";
                break;
            }

            let params = {
                "location": location,
                "long": long,
                "lati": lati
            };

            getWeatherInfo(params, function(error, weather) {
                let reply = '';
                if (error) {
                    console.log(error);
                    reply = 'Sorry, I couldn\'t find that city.';
                }
                else {
                    let temp = weather.observations[2].temp
                    let phrase = weather.observations[2].wx_phrase
                    reply = "Temperature today in " + params.location +" is " + temp +" " + phrase;
                    let query = '';
                    switch(phrase.toLowerCase()) {
                        case (phrase.match(/^Partly Cloudy/) || {}).input:
                            query = 'sandals';
                            console.log("Partly Cloudy")
                        break;

                        case (phrase.match(/^Cloudy/) || {}).input:
                            query = 'jacket';
                            console.log("Cloudy")
                        break;

                        default:
                            query = 'hat';
                            console.log("Haze")
                        break;
                    }

                    params.query = query;
                    getGoodzer(params, function(error, products) {
                        console.log("products " + products.stores[0]);
                        console.log("products " + products.stores[0].products[0].title);
                    });
                }

                resolve({'reply':reply, 'products':"<span style=\"color:red;\">Our product recommendations</span>"});
            });
        });
    }

    

    /**
     * Retrieves the user doc stored in the Cloudant database associated with the current user interacting with the bot.
     * First checks if the user is stored in Cloudant. If not, a new user is created in Cloudant.
     * @param {string} messageSender - The User ID from the messaging platform (Slack ID, or unique ID associated with the WebSocket client) 
     * @returns {Promise.<object|error>} - The user that was retrieved or created if fulfilled, or an error if rejected
     */
    getOrCreateUser(messageSender) {
        return this.userStore.addUser(messageSender);
    }

    /**
     * Updates the user doc in Cloudant with the latest Watson Conversation context.
     * @param {object} user - The user doc associated with the active user
     * @param {context} context - The Watson Conversation context
     * @returns {Promise.<object|error>} - The user that was updated if fulfilled, or an error if rejected
     */
    updateUserWithWatsonConversationContext(user, context) {
        return this.userStore.updateUser(user, context);
    }

    /**
     * Retrieves the ID of the active conversation doc in the Cloudant conversation log database for the current user.
     * If this is the start of a new converation then a new document is created in Cloudant,
     * and the ID of the document is associated with the Watson Conversation context.
     * @param {string} user - The user doc associated with the active user
     * @param {object} conversationResponse - The response from Watson Conversation
     * @returns {Promise.<string|error>} - The ID of the active conversation doc in Cloudant if fulfilled, or an error if rejected 
     */
    getOrCreateActiveConversationId(user, conversationResponse) {
        const newConversation = conversationResponse.context.newConversation;
        if (newConversation) {
            conversationResponse.context.newConversation = false;
            return this.dialogStore.addConversation(user._id)
                .then((conversationDoc) => {
                    conversationResponse.context.conversationDocId = conversationDoc._id;
                    return Promise.resolve(conversationDoc._id);
                });
        }
        else {
            return Promise.resolve(conversationResponse.context.conversationDocId);
        }
    }

    /**
     * Logs the dialog traversed in Watson Conversation by the current user to the Cloudant log database.
     * @param {string} conversationDocId - The ID of the active conversation doc in Cloudant 
     * @param {string} name - The name of the dialog (action)
     * @param {string} message - The message sent by the user
     * @param {string} reply - The reply sent to the user
     */
    logDialog(conversationDocId, name, message, reply) {
        if (! conversationDocId) {
            return;
        }
        let dialogDoc = {name:name, message:message, reply:reply, date:Date.now()};
        this.dialogStore.addDialog(conversationDocId, dialogDoc);
    }
}

module.exports = HealthBot;
