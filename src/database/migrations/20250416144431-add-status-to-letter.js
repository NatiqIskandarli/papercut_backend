'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    await queryInterface.addColumn('letters', 'status', {
      type: Sequelize.STRING,
      allowNull: false,
      defaultValue: 'pending'
    });
  },

  async down (queryInterface, Sequelize) {
    await queryInterface.removeColumn('letters', 'status');
  }
};
